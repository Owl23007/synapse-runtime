import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFile } from "../config/loader.js";
import { RuntimeServer } from "./runtime-server.js";

describe("runtime reload boundary", () => {
  it("rejects host settings without stopping the old server and allows a subsequent channel reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synapse-reload-"));
    const configPath = join(dir, "runtime.json");
    const initial = {
      runtime: { dataDir: join(dir, "data"), logLevel: "info" },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, enabled: true, logBufferSize: 300 },
      channels: {}
    };
    let server: RuntimeServer | undefined;
    try {
      await writeFile(configPath, JSON.stringify(initial));
      server = new RuntimeServer({
        config: await loadConfigFile(configPath, { env: {} }),
        configPath,
        loadConfigOptions: { env: {} },
        logger: { info() {}, warn() {}, error() {} }
      });
      const started = await server.start();
      const endpoint = `http://127.0.0.1:${started.admin!.port}`;
      const changes = [
        ["server", "host", "localhost"],
        ["server", "port", 3001],
        ["admin", "host", "localhost"],
        ["admin", "port", 3767],
        ["admin", "enabled", false],
        ["admin", "logBufferSize", 500],
        ["runtime", "logLevel", "debug"]
      ] as const;
      // 共用同一个配置文件与服务，必须串行验证拒绝后仍可继续操作
      await changes.reduce<Promise<void>>(async (previous, [section, field, value]) => {
        await previous;
        await writeFile(
          configPath,
          JSON.stringify({
            ...initial,
            [section]: { ...initial[section], [field]: value }
          })
        );
        const response = await fetch(`${endpoint}/admin/reload`, { method: "POST" });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: "reload_requires_restart",
          fields: [`${section}.${field}`]
        });
        const snapshot = await fetch(`${endpoint}/admin/config`).then((result) => result.json());
        expect(snapshot.config[section][field]).toBe(initial[section][field as keyof (typeof initial)[typeof section]]);
        expect(await fetch(`http://127.0.0.1:${started.port}/health`).then((result) => result.json())).toEqual({
          ok: true
        });
      }, Promise.resolve());
      await writeFile(
        configPath,
        JSON.stringify({
          ...initial,
          channels: { qq: { adapter: "qq-official", appId: "test", appSecret: "secret", enabled: false } }
        })
      );
      const response = await fetch(`${endpoint}/admin/reload`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        channels: [{ id: "qq", enabled: false }]
      });
    } finally {
      await server?.stop();
      expect(resolve(dir).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
