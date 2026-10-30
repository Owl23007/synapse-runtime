import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { SkillDirectoryLoader } from "./skill-directory.js";
import { extractSkillArchive } from "./skill-archive.js";
import { PromptBundleCompiler } from "./bundle.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "synapse-skill-"));
  roots.push(path);
  return path;
}
const manifest = "---\nname: report-analysis\ndescription: 分析报告\nlicense: MIT\n---\n先核对数据来源，再分析报告";

describe("standard skill snapshots", () => {
  it("loads standard frontmatter separately from runtime policy and reads resources progressively", () => {
    const path = root();
    writeFileSync(join(path, "SKILL.md"), manifest);
    mkdirSync(join(path, "references"));
    writeFileSync(join(path, "references", "guide.md"), "abcdefgh");
    const loader = new SkillDirectoryLoader(path);
    expect(loader.skill).toMatchObject({ name: "report-analysis", description: "分析报告", license: "MIT" });
    expect(loader.readResource("references/guide.md", 2, 3)).toMatchObject({ text: "cde", hasMore: true });
    expect(new SkillDirectoryLoader(path).skill.contentDigest).toBe(loader.skill.contentDigest);
    for (const value of ["../SKILL.md", "C:/secret", "/secret", "references\\guide.md", "%2e%2e/secret", ".env"])
      expect(() => loader.readResource(value)).toThrow();
    writeFileSync(join(path, "references", "guide.md"), "tampered");
    expect(() => loader.readResource("references/guide.md")).toThrow("integrity");
  });
  it("rejects malformed manifests and symlinks inside an installed directory", () => {
    const path = root();
    writeFileSync(join(path, "SKILL.md"), manifest.replace("name: report-analysis", "name: Upper_Case"));
    expect(() => new SkillDirectoryLoader(path)).toThrow();
    writeFileSync(
      join(path, "SKILL.md"),
      manifest.replace("description: 分析报告", "description: one\ndescription: two")
    );
    expect(() => new SkillDirectoryLoader(path)).toThrow();
    writeFileSync(join(path, "SKILL.md"), manifest);
    const outside = root();
    symlinkSync(outside, join(path, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => new SkillDirectoryLoader(path)).toThrow("links");
  });
  it("rejects traversal, symlink modes, entry floods, and decompression bombs before publication", async () => {
    const path = root();
    await expect(extractSkillArchive(zipSync({ "../escape": strToU8("bad") }), path)).rejects.toThrow();
    await expect(extractSkillArchive(zipSync({ "SKILL.md": new Uint8Array(3 * 1024 * 1024) }), path)).rejects.toThrow(
      "limits"
    );
    const entries = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`f${index}`, new Uint8Array()]));
    await expect(extractSkillArchive(zipSync(entries), path)).rejects.toThrow("directory");
    const bytes = Buffer.from(zipSync({ "SKILL.md": strToU8(manifest) }));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0xa1ff0000, central + 38);
    await expect(extractSkillArchive(bytes, path)).rejects.toThrow("Unsafe");
  });
  it("installs a selected Git subdirectory and compiles standard skills through the existing prompt compiler", async () => {
    const path = root();
    await extractSkillArchive(
      zipSync({ "repo-sha/skills/report/SKILL.md": strToU8(manifest), "repo-sha/README.md": strToU8("readme") }),
      path,
      { stripRoot: true, subdirectory: "skills/report" }
    );
    const loader = new SkillDirectoryLoader(path);
    const compiler = new PromptBundleCompiler(
      {
        prompts: [{ id: "base", stage: "reasoning", template: "分析请求" }],
        recipes: [{ id: "analysis", purpose: "reasoning.chat", basePromptIds: ["base"] }]
      },
      {}
    );
    const input = {
      purpose: "reasoning.chat",
      dimensions: {},
      toolIds: ["asset.read"],
      toolSetDigest: "tools",
      directorySkills: [
        {
          id: "install-one",
          version: loader.skill.contentDigest,
          contentDigest: loader.skill.contentDigest,
          description: loader.skill.description
        }
      ]
    };
    const catalog = compiler.compile(input);
    expect(catalog.capabilities.activeSkills).toEqual([]);
    expect(catalog.prompt.blocks.at(-1)?.content).not.toContain(loader.skill.instructions);
    const activated = compiler.compile({
      ...input,
      requestedSkillIds: ["install-one"],
      directorySkills: [{ ...input.directorySkills[0]!, instructions: loader.skill.instructions }]
    });
    expect(activated.capabilities.activeSkills).toEqual([
      { id: "install-one", version: loader.skill.contentDigest, reason: "explicit" }
    ]);
    expect(activated.prompt.blocks.at(-1)?.content).toBe(loader.skill.instructions);
    expect(activated.capabilities.toolIds).toEqual(["asset.read"]);
  });
});
