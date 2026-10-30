import { rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { loadConfigFile } from "../../../src/config/loader.js";
import { createApplicationConfigManager, runtimeConfig } from "../../../src/config/manager.js";
import { MemoryConfigSource } from "@synapse/runtime-config";

describe("运行时配置分层", () => {
  it("按文件、工作区、用户、环境与命令行优先级合并且不持久化默认值", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synapse-sources-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const app = join(dir, "app.json"),
      workspace = join(dir, "workspace.json"),
      user = join(dir, "user.json");
    await writeFile(app, JSON.stringify({ admin: { port: 3001, host: "127.0.0.2" } }));
    await writeFile(workspace, JSON.stringify({ admin: { port: 3002 } }));
    const content = JSON.stringify({ admin: { port: 3003 } });
    await writeFile(user, content);
    const common = { workspaceConfigPath: workspace, userConfigPath: user, env: { SYNAPSE__admin__port: "3004" } };
    expect((await loadConfigFile(app, common)).admin.port).toBe(3004);
    const config = await loadConfigFile(app, { ...common, cliOverrides: { admin: { port: 3005 } } });
    expect(config.admin).toMatchObject({ port: 3005, host: "127.0.0.2" });
    expect(await readFile(user, "utf8")).toBe(content);
  });
  it("相对于用户配置来源目录解析资源路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synapse-paths-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "user"));
    const app = join(dir, "app.json"),
      user = join(dir, "user", "config.json");
    await writeFile(app, "{}");
    await writeFile(user, JSON.stringify({ locale: { catalogPath: "messages.yaml" } }));
    expect((await loadConfigFile(app, { userConfigPath: user, env: {} })).locale.catalogPath).toBe(
      join(dir, "user", "messages.yaml")
    );
  });
  it("提供模块配置类型并拒绝无效部署值", async () => {
    const manager = createApplicationConfigManager([
      new MemoryConfigSource("deployment", 1, { modules: { runtime: { logLevel: "debug" } } })
    ]);
    await manager.resolve();
    expect(manager.get(runtimeConfig).logLevel).toBe("debug");
    const dir = await mkdtemp(join(tmpdir(), "synapse-invalid-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "config.json");
    await writeFile(path, "{}");
    await expect(loadConfigFile(path, { env: {}, cliOverrides: { admin: { port: -1 } } })).rejects.toThrow(
      /module=admin, source=cli/
    );
  });

  it("报告稳定的层名称而非源文件路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synapse-layers-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const deployment = join(dir, "runtime.json");
    const user = join(dir, "user.json");
    await writeFile(deployment, "{}");
    await writeFile(user, JSON.stringify({ admin: { port: -1 } }));
    await expect(loadConfigFile(deployment, { userConfigPath: user, env: {} })).rejects.toThrow(
      /module=admin, source=user/
    );
  });
});
