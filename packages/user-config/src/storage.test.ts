import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile, saveProfileConfig } from "./index.js";

describe("user configuration persistence", () => {
  it("replaces complete files and leaves no temporary artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-config-"));
    const path = join(dir, "config.json");
    await atomicWriteFile(path, '{"value":1}');
    await atomicWriteFile(path, '{"value":2}');
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ value: 2 });
    expect(await readdir(dir)).toEqual(["config.json"]);
  });
  it("validates profile data before replacing the previous file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "user-profile-"));
    const path = join(dir, "profile.json");
    await saveProfileConfig({ profiles: {} }, path);
    const previous = await readFile(path, "utf8");
    await expect(saveProfileConfig({ current: "missing", profiles: {} }, path)).rejects.toThrow(/not configured/);
    expect(await readFile(path, "utf8")).toBe(previous);
  });
});
