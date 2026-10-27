import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupRuntimeData, restoreRuntimeData, verifyRuntimeBackup } from "./maintenance.js";
import { SqliteRuntimeContextStore } from "./storage/sqlite/runtime-context-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synapse-maintenance-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const store = new SqliteRuntimeContextStore({ databasePath: join(dataDir, "runtime-context.sqlite") });
  const run = store.runs.accept({ sourceEventId: "event", sessionId: "session", channelId: "qq", summary: "备份样本" });
  mkdirSync(join(dataDir, "artifacts"));
  mkdirSync(join(dataDir, "artifact-deliveries"));
  writeFileSync(join(dataDir, "artifacts", "file.bin"), Buffer.from("binary-content"));
  writeFileSync(join(dataDir, "artifacts", "selection-test.json"), '{"selectedIds":["file"]}');
  writeFileSync(join(dataDir, "artifact-deliveries", "upload.pending"), "pending");
  writeFileSync(join(dataDir, "artifact-deliveries", "upload.json"), '{"status":"succeeded"}');
  return { root, dataDir, store, run, backup: join(root, "backup"), restored: join(root, "restored") };
}

describe("离线一致性备份与恢复", () => {
  it("包含未 checkpoint 的 WAL 数据、工件选择与回执，重复校验不污染快照", async () => {
    const f = fixture();
    try {
      expect(existsSync(join(f.dataDir, "runtime-context.sqlite-wal"))).toBe(true);
      const backup = await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
      expect(backup.files).toHaveLength(5);
      expect(await verifyRuntimeBackup(f.backup)).toEqual(backup);
      expect(await verifyRuntimeBackup(f.backup)).toEqual(backup);
      expect(existsSync(join(f.backup, "runtime-context.sqlite-wal"))).toBe(false);
      await restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored });
      const restored = new SqliteRuntimeContextStore({
        databasePath: join(f.restored, "runtime-context.sqlite"),
        exclusiveOwner: true
      });
      try {
        expect(restored.runs.get(f.run.id)).toEqual(f.run);
      } finally {
        restored.close();
      }
      for (const path of [
        "artifacts/file.bin",
        "artifacts/selection-test.json",
        "artifact-deliveries/upload.pending",
        "artifact-deliveries/upload.json"
      ])
        expect(readFileSync(join(f.restored, path))).toEqual(readFileSync(join(f.dataDir, path)));
      expect(
        () =>
          new SqliteRuntimeContextStore({
            databasePath: join(f.backup, "runtime-context.sqlite"),
            exclusiveOwner: true
          })
      ).toThrow("备份");
    } finally {
      f.store.close();
    }
  });

  it("活动 Runtime 拒绝备份，关闭后可备份且不覆盖任何已有目录", async () => {
    const f = fixture();
    f.store.close();
    const owner = new SqliteRuntimeContextStore({
      databasePath: join(f.dataDir, "runtime-context.sqlite"),
      exclusiveOwner: true
    });
    try {
      await expect(backupRuntimeData({ dataDir: f.dataDir, destination: f.backup })).rejects.toThrow("另一个 Runtime");
    } finally {
      owner.close();
    }
    await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
    await expect(backupRuntimeData({ dataDir: f.dataDir, destination: f.backup })).rejects.toThrow();
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.dataDir })).rejects.toThrow();
    await expect(backupRuntimeData({ dataDir: f.dataDir, destination: join(f.dataDir, "nested") })).rejects.toThrow(
      "重叠"
    );
    expect(existsSync(join(f.dataDir, "nested"))).toBe(false);
  });

  it("篡改文件导致恢复失败，半成品不能启动且原目录不受影响", async () => {
    const f = fixture();
    f.store.close();
    await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
    writeFileSync(join(f.backup, "artifacts", "file.bin"), "tampered");
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("校验失败");
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored })).rejects.toThrow("校验失败");
    expect(
      () =>
        new SqliteRuntimeContextStore({
          databasePath: join(f.restored, "runtime-context.sqlite"),
          exclusiveOwner: true
        })
    ).toThrow("维护未完成");
    expect(readFileSync(join(f.dataDir, "artifacts", "file.bin"), "utf8")).toBe("binary-content");
  });

  it("拒绝穿越和大小写重复清单，不创建目标目录", async () => {
    const f = fixture();
    f.store.close();
    const manifest = await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
    const file = manifest.files.find((item) => item.path === "artifacts/file.bin")!;
    writeFileSync(
      join(f.backup, "backup-manifest.json"),
      JSON.stringify({ ...manifest, files: [...manifest.files, { ...file, path: "artifacts/../outside" }] })
    );
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored })).rejects.toThrow("路径无效");
    writeFileSync(
      join(f.backup, "backup-manifest.json"),
      JSON.stringify({ ...manifest, files: [...manifest.files, { ...file, path: "artifacts/FILE.bin" }] })
    );
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored })).rejects.toThrow("重复路径");
    expect(existsSync(f.restored)).toBe(false);
  });

  it("拒绝硬链接文件，备份不会迁移原数据库", async () => {
    const f = fixture();
    f.store.close();
    const db = new Database(join(f.dataDir, "runtime-context.sqlite"));
    db.pragma("user_version = 99");
    db.close();
    await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
    expect((await verifyRuntimeBackup(f.backup)).databaseVersion).toBe(99);
    linkSync(join(f.dataDir, "artifacts", "file.bin"), join(f.root, "outside-link"));
    await expect(backupRuntimeData({ dataDir: f.dataDir, destination: join(f.root, "linked-backup") })).rejects.toThrow(
      "普通文件"
    );
    await expect(verifyRuntimeBackup(join(f.root, "linked-backup"))).rejects.toThrow("备份未完成");
    expect(
      () =>
        new SqliteRuntimeContextStore({
          databasePath: join(f.root, "linked-backup", "runtime-context.sqlite"),
          exclusiveOwner: true
        })
    ).toThrow("维护未完成");
    // 失败也释放源目录锁，后续维护可以重新获取，不需要删除锁文件
    await expect(backupRuntimeData({ dataDir: f.dataDir, destination: join(f.root, "retry") })).rejects.toThrow(
      "普通文件"
    );
  });
});
