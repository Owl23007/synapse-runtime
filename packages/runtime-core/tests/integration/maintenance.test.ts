import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { onTestFinished, describe, expect, it } from "vitest";
import { backupRuntimeData, restoreRuntimeData, verifyRuntimeBackup } from "../../src/maintenance.js";
import { SqliteRuntimeContextStore } from "../../src/storage/sqlite/runtime-context-store.js";

function createMaintenanceFixture() {
  const root = mkdtempSync(join(tmpdir(), "synapse-maintenance-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const store = new SqliteRuntimeContextStore({ databasePath: join(dataDir, "runtime-context.sqlite") });
  onTestFinished(() => store.close());
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
    const testContext = createMaintenanceFixture();
    try {
      expect(existsSync(join(testContext.dataDir, "runtime-context.sqlite-wal"))).toBe(true);
      const backup = await backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup });
      expect(backup.files).toHaveLength(5);
      expect(await verifyRuntimeBackup(testContext.backup)).toEqual(backup);
      expect(await verifyRuntimeBackup(testContext.backup)).toEqual(backup);
      expect(existsSync(join(testContext.backup, "runtime-context.sqlite-wal"))).toBe(false);
      await restoreRuntimeData({ backupDir: testContext.backup, dataDir: testContext.restored });
      const restored = new SqliteRuntimeContextStore({
        databasePath: join(testContext.restored, "runtime-context.sqlite"),
        exclusiveOwner: true
      });
      onTestFinished(() => restored.close());
      try {
        expect(restored.runs.get(testContext.run.id)).toEqual(testContext.run);
      } finally {
        restored.close();
      }
      for (const path of [
        "artifacts/file.bin",
        "artifacts/selection-test.json",
        "artifact-deliveries/upload.pending",
        "artifact-deliveries/upload.json"
      ])
        expect(readFileSync(join(testContext.restored, path))).toEqual(readFileSync(join(testContext.dataDir, path)));
      expect(
        () =>
          new SqliteRuntimeContextStore({
            databasePath: join(testContext.backup, "runtime-context.sqlite"),
            exclusiveOwner: true
          })
      ).toThrow("备份");
    } finally {
      testContext.store.close();
    }
  });

  it("活动 Runtime 拒绝备份，关闭后可备份且不覆盖任何已有目录", async () => {
    const testContext = createMaintenanceFixture();
    testContext.store.close();
    const owner = new SqliteRuntimeContextStore({
      databasePath: join(testContext.dataDir, "runtime-context.sqlite"),
      exclusiveOwner: true
    });
    onTestFinished(() => owner.close());
    try {
      await expect(
        backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup })
      ).rejects.toThrow("另一个 Runtime");
    } finally {
      owner.close();
    }
    await backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup });
    await expect(
      backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup })
    ).rejects.toThrow();
    await expect(restoreRuntimeData({ backupDir: testContext.backup, dataDir: testContext.dataDir })).rejects.toThrow();
    await expect(
      backupRuntimeData({ dataDir: testContext.dataDir, destination: join(testContext.dataDir, "nested") })
    ).rejects.toThrow("重叠");
    expect(existsSync(join(testContext.dataDir, "nested"))).toBe(false);
  });

  it("篡改文件导致恢复失败，半成品不能启动且原目录不受影响", async () => {
    const testContext = createMaintenanceFixture();
    testContext.store.close();
    await backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup });
    writeFileSync(join(testContext.backup, "artifacts", "file.bin"), "tampered");
    await expect(verifyRuntimeBackup(testContext.backup)).rejects.toThrow("校验失败");
    await expect(restoreRuntimeData({ backupDir: testContext.backup, dataDir: testContext.restored })).rejects.toThrow(
      "校验失败"
    );
    expect(
      () =>
        new SqliteRuntimeContextStore({
          databasePath: join(testContext.restored, "runtime-context.sqlite"),
          exclusiveOwner: true
        })
    ).toThrow("维护未完成");
    expect(readFileSync(join(testContext.dataDir, "artifacts", "file.bin"), "utf8")).toBe("binary-content");
  });

  it("拒绝穿越和大小写重复清单，不创建目标目录", async () => {
    const testContext = createMaintenanceFixture();
    testContext.store.close();
    const manifest = await backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup });
    const file = manifest.files.find((item) => item.path === "artifacts/file.bin")!;
    writeFileSync(
      join(testContext.backup, "backup-manifest.json"),
      JSON.stringify({ ...manifest, files: [...manifest.files, { ...file, path: "artifacts/../outside" }] })
    );
    await expect(restoreRuntimeData({ backupDir: testContext.backup, dataDir: testContext.restored })).rejects.toThrow(
      "路径无效"
    );
    writeFileSync(
      join(testContext.backup, "backup-manifest.json"),
      JSON.stringify({ ...manifest, files: [...manifest.files, { ...file, path: "artifacts/FILE.bin" }] })
    );
    await expect(restoreRuntimeData({ backupDir: testContext.backup, dataDir: testContext.restored })).rejects.toThrow(
      "重复路径"
    );
    expect(existsSync(testContext.restored)).toBe(false);
  });

  it("拒绝硬链接文件，备份不会迁移原数据库", async () => {
    const testContext = createMaintenanceFixture();
    testContext.store.close();
    const db = new Database(join(testContext.dataDir, "runtime-context.sqlite"));
    db.pragma("user_version = 99");
    db.close();
    await backupRuntimeData({ dataDir: testContext.dataDir, destination: testContext.backup });
    expect((await verifyRuntimeBackup(testContext.backup)).databaseVersion).toBe(99);
    linkSync(join(testContext.dataDir, "artifacts", "file.bin"), join(testContext.root, "outside-link"));
    await expect(
      backupRuntimeData({ dataDir: testContext.dataDir, destination: join(testContext.root, "linked-backup") })
    ).rejects.toThrow("普通文件");
    await expect(verifyRuntimeBackup(join(testContext.root, "linked-backup"))).rejects.toThrow("备份未完成");
    expect(
      () =>
        new SqliteRuntimeContextStore({
          databasePath: join(testContext.root, "linked-backup", "runtime-context.sqlite"),
          exclusiveOwner: true
        })
    ).toThrow("维护未完成");
    // 失败也释放源目录锁，后续维护可以重新获取，不需要删除锁文件
    await expect(
      backupRuntimeData({ dataDir: testContext.dataDir, destination: join(testContext.root, "retry") })
    ).rejects.toThrow("普通文件");
  });
});
