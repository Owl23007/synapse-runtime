import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "nova-http";
import { describe, expect, it } from "vitest";
import { registerWebUi } from "./webui.js";
import { getNovaServerAddress } from "../http.js";

describe("Admin WebUI 静态资源边界", () => {
  it("仅返回构建外壳与白名单资源，不将不存在的 API 或任意文件回退为 HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synapse-webui-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Synapse</title>");
    await writeFile(join(directory, "assets/index-abc.js"), "export const app = true;");
    await writeFile(join(directory, "secret.txt"), "private");
    const app = createApp();
    registerWebUi(app, directory);
    await app.listen(0, "127.0.0.1");
    try {
      const address = getNovaServerAddress(app) as { port: number };
      const url = `http://127.0.0.1:${address.port}`;
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const script = await fetch(url + "/assets/index-abc.js");
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect(await script.text()).toContain("export const app");
      for (const path of [
        "/secret.txt",
        "/assets/secret.txt",
        "/assets/..%5csecret.txt",
        "/assets/no.js",
        "/admin/missing"
      ])
        expect((await fetch(url + path)).status).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
