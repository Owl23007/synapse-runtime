import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/** 用独立 SQLite 文件持有操作系统级独占锁，进程崩溃后自动释放而不依赖 PID 猜测 */
export function acquireDirectoryLease(databasePath: string): () => void {
  if (databasePath === ":memory:") throw new Error("独占运行实例需要持久数据目录");
  mkdirSync(dirname(databasePath), { recursive: true });
  const directory = realpathSync(dirname(databasePath));
  const lock = new Database(join(directory, ".runtime-lease.sqlite"), { timeout: 0 });
  try {
    lock.exec("CREATE TABLE IF NOT EXISTS lease_marker (id INTEGER PRIMARY KEY)");
    // 锁文件不使用 WAL，保持排他事务直到整个 Runtime 与存储关闭
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new Error("数据目录正被另一个 Runtime 或维护操作使用，请先停止现有实例");
  }
  return () => {
    if (lock.open) lock.close();
  };
}
