import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileConfigSource, loadEnvFile, parseConfigFileContent } from "./node.js";

describe("Node file sources", () => {
  it("loads JSON, TOML and YAML without business schema dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-source-"));
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
  it("rejects unsupported formats and non-object roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-source-invalid-"));
    const path = join(dir, "invalid.json");
    await writeFile(path, "[]");
    await expect(new FileConfigSource("bad", 20, path).load()).rejects.toThrow(/object/);
    const unsupported = join(dir, "invalid.txt");
    await writeFile(unsupported, "x=1");
    await expect(new FileConfigSource("bad", 20, unsupported).load()).rejects.toThrow(/Unsupported/);
  });

  it("shares parsing and dotenv loading across Node hosts", async () => {
    expect(parseConfigFileContent('[runtime]\nmode = "local"', "runtime.toml")).toEqual({
      runtime: { mode: "local" }
    });
    const dir = await mkdtemp(join(tmpdir(), "config-env-"));
    const path = join(dir, ".env");
    await writeFile(path, '# ignored\nTOKEN = "from-file"\nKEEP=file\n');
    const env = { KEEP: "process" };
    loadEnvFile(path, env);
    expect(env).toEqual({ KEEP: "process", TOKEN: "from-file" });
  });
});
