import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { FileConfigSource, loadEnvFile, parseConfigFileContent } from "../../src/node.js";

describe("Node 文件配置来源", () => {
  it("加载 JSON、TOML 与 YAML 且不依赖业务模式", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-source-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const formats = {
      json: '{"modules":{"editor":{"enabled":true}}}',
      toml: "[modules.editor]\nenabled = true",
      yaml: "modules:\n  editor:\n    enabled: true"
    };
    await Promise.all(
      Object.entries(formats).map(async ([extension, content]) => {
        const path = join(dir, `source.${extension}`);
        await writeFile(path, content);
        expect(await new FileConfigSource(path, 20, path).load()).toEqual({ modules: { editor: { enabled: true } } });
      })
    );
  });
  it("拒绝不支持的格式与非对象根节点", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-source-invalid-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "invalid.json");
    await writeFile(path, "[]");
    await expect(new FileConfigSource("bad", 20, path).load()).rejects.toThrow(/object/);
    const unsupported = join(dir, "invalid.txt");
    await writeFile(unsupported, "x=1");
    await expect(new FileConfigSource("bad", 20, unsupported).load()).rejects.toThrow(/Unsupported/);
  });

  it("在 Node 宿主间共享解析与环境文件加载", async () => {
    expect(parseConfigFileContent('[runtime]\nmode = "local"', "runtime.toml")).toEqual({
      runtime: { mode: "local" }
    });
    const dir = await mkdtemp(join(tmpdir(), "config-env-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, ".env");
    await writeFile(path, '# ignored\nTOKEN = "from-file"\nKEEP=file\n');
    const env = { KEEP: "process" };
    loadEnvFile(path, env);
    expect(env).toEqual({ KEEP: "process", TOKEN: "from-file" });
  });
});
