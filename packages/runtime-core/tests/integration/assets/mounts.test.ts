import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { ReadonlyMounts } from "../../../src/assets/mounts.js";

describe("只读虚拟挂载", () => {
  it("仅读取声明根目录内的普通文件并拒绝穿越、隐藏文件与符号链接逃逸", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapse-mount-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const shared = join(root, "shared");
    const secret = join(root, "private");
    mkdirSync(shared);
    mkdirSync(secret);
    writeFileSync(join(shared, "report.txt"), "version one");
    writeFileSync(join(shared, ".env"), "secret");
    writeFileSync(join(secret, "passwords.txt"), "secret");
    symlinkSync(secret, join(shared, "escape"), process.platform === "win32" ? "junction" : "dir");
    const mounts = new ReadonlyMounts(
      [
        {
          id: "shared",
          root: shared,
          urlPrefix: "/files/shared",
          access: "authenticated",
          allowPublic: false,
          readOnly: true
        }
      ],
      100
    );
    expect(mounts.list()[0]).not.toHaveProperty("root");
    expect((await mounts.read("shared", "report.txt")).bytes.toString()).toBe("version one");
    expect((await mounts.entries("shared")).items).toEqual([{ name: "report.txt", directory: false }]);
    for (const path of [
      "../../../src/private/passwords.txt",
      "%2e%2e/private/passwords.txt",
      "../../../src/private/passwords.txt",
      ".env",
      "escape/passwords.txt",
      "report.txt/../.env"
    ])
      await expect(mounts.read("shared", path)).rejects.toMatchObject({ status: 403 });
    await expect(mounts.read("other", "report.txt")).rejects.toMatchObject({ status: 404 });
  });
  it("要求显式公开批准并约束内容预算", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapse-mount-limit-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "large.txt"), "0123456789");
    expect(
      () =>
        new ReadonlyMounts(
          [{ id: "public", root, urlPrefix: "/files/public", access: "public", allowPublic: false, readOnly: true }],
          1
        )
    ).toThrow("invalid");
    const mounts = new ReadonlyMounts(
      [{ id: "shared", root, urlPrefix: "/files/shared", access: "private", allowPublic: false, readOnly: true }],
      5
    );
    await expect(mounts.read("shared", "large.txt")).rejects.toThrow("mount_access_denied");
  });
});
