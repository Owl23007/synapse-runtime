import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { onTestFinished, describe, expect, it } from "vitest";
import { acquireDirectoryLease } from "../../../../src/storage/sqlite/directory-lease.js";
import { SqliteRuntimeContextStore } from "../../../../src/storage/sqlite/runtime-context-store.js";

describe("生产目录独占", () => {
  it("拒绝重复实例，允许检查连接，关闭后立即重新取得目录", () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-lease-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "runtime-context.sqlite");
    const owner = new SqliteRuntimeContextStore({ databasePath, exclusiveOwner: true });
    onTestFinished(() => owner.close());
    try {
      expect(() => new SqliteRuntimeContextStore({ databasePath, exclusiveOwner: true })).toThrow("数据目录");
      const reader = new SqliteRuntimeContextStore({ databasePath });
      onTestFinished(() => reader.close());
      reader.close();
      owner.close();
      const next = new SqliteRuntimeContextStore({ databasePath, exclusiveOwner: true });
      onTestFinished(() => next.close());
      next.close();
    } finally {
      owner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("进程被终止后锁自动释放，无需删除文件或信任过期 PID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-crash-lease-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import Database from "better-sqlite3"; const db=new Database(process.argv[1]); db.exec("CREATE TABLE IF NOT EXISTS lease_marker (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE"); process.stdout.write("ready"); setInterval(()=>db.open,1000);',
        join(directory, ".runtime-lease.sqlite")
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let unexpectedLease: (() => void) | undefined;
    try {
      const [ready] = await once(child.stdout, "data");
      expect(String(ready)).toBe("ready");
      expect(() => {
        unexpectedLease = acquireDirectoryLease(join(directory, "context.sqlite"));
      }).toThrow("数据目录");
      const exited = once(child, "exit");
      child.kill();
      await exited;
      acquireDirectoryLease(join(directory, "context.sqlite"))();
    } finally {
      unexpectedLease?.();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
