import { rmSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { atomicWriteFile, saveProfileConfig } from "../../src/index.js";

describe("用户配置持久化", () => {
  it("替换完整文件且不遗留临时工件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-config-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "config.json");
    await atomicWriteFile(path, '{"value":1}');
    await atomicWriteFile(path, '{"value":2}');
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ value: 2 });
    expect(await readdir(dir)).toEqual(["config.json"]);
  });
  it("替换旧文件前校验档案数据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-profile-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "profile.json");
    await saveProfileConfig({ profiles: {} }, path);
    const previous = await readFile(path, "utf8");
    await expect(saveProfileConfig({ current: "missing", profiles: {} }, path)).rejects.toThrow(/not configured/);
    expect(await readFile(path, "utf8")).toBe(previous);
  });
});
