import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readRawConfigFile } from "@synapse/runtime-config/node";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { loadConfigFile } from "../../src/config/loader.js";
import { readConfigEditor, saveConfigEditor } from "../../src/config/editor.js";
import { updateChannelConfigFile } from "../../src/config/channel-editor.js";
import { RuntimeServer } from "../../src/server/runtime-server.js";

async function fixture(extension = "json") {
  const directory = await mkdtemp(join(tmpdir(), "synapse-config-editor-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, `runtime.${extension}`);
  const raw = {
    runtime: { dataDir: join(directory, "data") },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "admin-secret" },
    agent: {
      default: "test",
      providers: {
        test: {
          type: "openai-compatible",
          model: "test-model",
          baseUrl: "https://example.com/v1",
          apiKey: "${MODEL_KEY}",
          maxTokens: 500,
          headers: { Authorization: "Bearer secret" }
        }
      }
    },
    channels: { qq: { adapter: "qq-official", appId: "app", appSecret: "qq-secret", enabled: false } },
    custom: { entries: [{ secret: "first" }, { secret: "second" }] }
  };
  await writeFile(path, JSON.stringify(raw));
  const options = { env: { MODEL_KEY: "expanded-secret" } };
  const config = await loadConfigFile(path, options);
  return { path, raw, config, options };
}

describe("配置文件按项编辑", () => {
  it("提供完整表单规则，隐藏密钥且保留 Token 数量", async () => {
    const { path, config, options } = await fixture();
    const snapshot = await readConfigEditor(path, config, options);
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "admin-secret",
      "MODEL_KEY",
      "expanded-secret",
      "qq-secret",
      "Bearer secret",
      '"first"',
      '"second"'
    ])
      expect(serialized).not.toContain(secret);
    expect(snapshot.config.agent).toMatchObject({ providers: { test: { maxTokens: 500, apiKey: "[REDACTED]" } } });
    expect(snapshot.schema.properties?.runtime?.properties?.mode?.enum).toEqual(["local", "attached", "hosted"]);
    expect(snapshot.schema.properties?.channels?.additionalProperties).toHaveProperty("oneOf");
    expect(serialized).not.toContain('"$ref"');
    expect(snapshot.secretPaths).toContainEqual(["agent", "providers", "test", "apiKey"]);
  });

  it("只写选中字段，保留占位符、未知数据和数组删除后的密钥归属", async () => {
    const { path, config, options } = await fixture();
    const snapshot = await readConfigEditor(path, config, options);
    expect(
      await saveConfigEditor(
        path,
        {
          revision: snapshot.revision,
          changes: [
            { path: ["agent", "providers", "test", "model"], value: "updated" },
            { path: ["permissions", "network.web.fetch"], value: "deny" },
            { path: ["custom", "entries", "0"], remove: true },
            { path: ["custom", "entries", "0", "label"], value: "retained" }
          ]
        },
        config,
        options
      )
    ).toMatchObject({ reloadRequired: true, restartFields: [] });
    const raw = await readRawConfigFile(path);
    expect(raw.agent).toMatchObject({ providers: { test: { model: "updated", apiKey: "${MODEL_KEY}" } } });
    expect(raw.custom).toEqual({ entries: [{ secret: "second", label: "retained" }] });
    expect(raw.permissions).toEqual({ "network.web.fetch": "deny" });
    expect(raw.context).toBeUndefined();
  });

  it("非法配置和危险路径不会落盘，错误不包含提交的密钥", async () => {
    const { path, config, options } = await fixture();
    const snapshot = await readConfigEditor(path, config, options);
    const original = await readFile(path, "utf8");
    for (const changes of [
      [
        { path: ["server", "port"], value: 99999 },
        { path: ["agent", "providers", "test", "apiKey"], value: "private-input" }
      ],
      [{ path: ["__proto__", "polluted"], value: true }],
      [{ path: ["admin", "token"], value: "[REDACTED]" }],
      [{ path: ["custom", "entries", "99"], value: {} }],
      [{ path: ["admin", "token"], remove: true, value: "ignored" }]
    ]) {
      const error = await saveConfigEditor(path, { revision: snapshot.revision, changes }, config, options).catch(
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain("private-input");
      expect(await readFile(path, "utf8")).toBe(original);
    }
    expect(Object.hasOwn({}, "polluted")).toBe(false);
  });

  it("并发保存和频道更新使用同一个文件队列，旧快照不能覆盖新文件", async () => {
    const { path, config, options } = await fixture();
    const snapshot = await readConfigEditor(path, config, options);
    const results = await Promise.allSettled([
      saveConfigEditor(
        path,
        { revision: snapshot.revision, changes: [{ path: ["context", "enabled"], value: false }] },
        config,
        options
      ),
      saveConfigEditor(
        path,
        { revision: snapshot.revision, changes: [{ path: ["context", "enabled"], value: true }] },
        config,
        options
      )
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "config_conflict" } });
    // 频道编辑使用进程环境，因此此用例用字面密钥替代占位符
    const latest = await readConfigEditor(path, config, options);
    await saveConfigEditor(
      path,
      { revision: latest.revision, changes: [{ path: ["agent", "providers", "test", "apiKey"], value: "literal" }] },
      config,
      options
    );
    const beforeChannel = await readConfigEditor(path, config, options);
    await updateChannelConfigFile(path, "qq", { appId: "updated-app" });
    await expect(
      saveConfigEditor(
        path,
        { revision: beforeChannel.revision, changes: [{ path: ["context", "enabled"], value: true }] },
        config,
        options
      )
    ).rejects.toMatchObject({ code: "config_conflict" });
    expect((await readRawConfigFile(path)).channels).toMatchObject({ qq: { appId: "updated-app" } });
  });

  it.each(["toml", "yaml"])("保存 %s 时保持文件格式与未修改字段", async (format) => {
    const { path: jsonPath, config, options } = await fixture();
    const path = jsonPath.replace(/json$/, format);
    await writeFile(
      path,
      format === "toml"
        ? '[runtime]\nmode = "local"\n[custom]\nkeep = "yes"\n'
        : "runtime:\n  mode: local\ncustom:\n  keep: yes\n"
    );
    const snapshot = await readConfigEditor(path, config, options);
    await saveConfigEditor(
      path,
      { revision: snapshot.revision, changes: [{ path: ["runtime", "mode"], value: "attached" }] },
      config,
      options
    );
    expect(await readRawConfigFile(path)).toMatchObject({ runtime: { mode: "attached" }, custom: { keep: "yes" } });
  });

  it("使用与启动相同的来源覆盖校验，并报告实际需要重启的字段", async () => {
    const { path, options } = await fixture();
    const layeredOptions = { ...options, cliOverrides: { server: { port: 0 } } };
    const config = await loadConfigFile(path, layeredOptions);
    const snapshot = await readConfigEditor(path, config, layeredOptions);
    const result = await saveConfigEditor(
      path,
      {
        revision: snapshot.revision,
        changes: [
          { path: ["server", "port"], value: 8080 },
          { path: ["runtime", "logLevel"], value: "debug" }
        ]
      },
      config,
      layeredOptions
    );
    expect(result.restartFields).toEqual(["runtime.logLevel"]);
  });

  it("管理 API 认证、保存与应用构成完整链路", async () => {
    const { path, options } = await fixture();
    const loadOptions = {
      ...options,
      cliOverrides: { agent: { default: "echo", providers: { echo: { type: "echo" } } } }
    };
    const server = new RuntimeServer({
      config: await loadConfigFile(path, loadOptions),
      configPath: path,
      loadConfigOptions: loadOptions,
      logger: { info() {}, warn() {}, error() {} }
    });
    onTestFinished(() => server.stop());
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "admin-secret" });
    expect((await fetch(`${endpoint}/admin/config/editor`)).status).toBe(401);
    expect(
      (
        await fetch(`${endpoint}/admin/config`, {
          method: "PATCH",
          body: "{}",
          headers: { "content-type": "application/json" }
        })
      ).status
    ).toBe(401);
    const snapshot = await client.configEditor();
    await expect(
      client.saveConfig(snapshot.revision, [{ path: ["context", "enabled"], value: false }])
    ).resolves.toMatchObject({ reloadRequired: true });
    expect(await client.config()).toMatchObject({ config: { context: { enabled: true } } });
    await client.reload();
    expect(await client.config()).toMatchObject({ config: { context: { enabled: false } } });
    await expect(client.saveConfig(snapshot.revision, [{ path: ["context", "enabled"], value: true }])).rejects.toThrow(
      "config_conflict"
    );
  });
});
