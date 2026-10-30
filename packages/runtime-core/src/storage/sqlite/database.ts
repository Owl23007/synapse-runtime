import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrateSqliteRuntimeContextStore } from "./migrations.js";
import { CONTEXT_GRAPH_SCHEMA_SQL } from "./context-graph-schema.js";
import { RESOURCE_SCHEMA_SQL } from "./resource-schema.js";
import { CAPABILITY_SCHEMA_SQL } from "./capability-schema.js";

/** 统一连接配置与迁移，初始化失败时关闭连接避免泄漏 */
export function openRuntimeDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      const version = db.pragma("user_version", { simple: true }) as number;
      if (version > 7) throw new Error(`Unsupported runtime database version: ${version}`);
      db.exec("CREATE TABLE IF NOT EXISTS runtime_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      const known = new Set(["context-v7", "context-graph-v1"]);
      const history = db.prepare("SELECT id FROM runtime_migrations").all() as { id: string }[];
      if (history.some((entry) => !known.has(entry.id))) throw new Error("Unsupported runtime database migration");
      const applied = db.prepare("SELECT id FROM runtime_migrations WHERE id = ?");
      const record = db.prepare("INSERT INTO runtime_migrations VALUES (?, ?)");
      if (!applied.get("context-v7")) {
        migrateSqliteRuntimeContextStore(db);
        record.run("context-v7", new Date().toISOString());
      }
      if (!applied.get("context-graph-v1")) {
        db.exec(CONTEXT_GRAPH_SCHEMA_SQL);
        record.run("context-graph-v1", new Date().toISOString());
      }
      // 与 run_trace_migrations 一样，资源领域独立记账，核心会话版本不承担其他领域版本
      db.exec("CREATE TABLE IF NOT EXISTS resource_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      const resourceHistory = db.prepare("SELECT id FROM resource_migrations").all() as { id: string }[];
      if (resourceHistory.some((entry) => !["resources-v1", "capabilities-v1"].includes(entry.id)))
        throw new Error("Unsupported resource database migration");
      const resourceApplied = db.prepare("SELECT 1 FROM resource_migrations WHERE id = ?");
      const resourceRecord = db.prepare("INSERT INTO resource_migrations VALUES (?, ?)");
      if (!resourceApplied.get("resources-v1")) {
        db.exec(RESOURCE_SCHEMA_SQL);
        resourceRecord.run("resources-v1", new Date().toISOString());
      }
      if (!resourceApplied.get("capabilities-v1")) {
        db.exec(CAPABILITY_SCHEMA_SQL);
        resourceRecord.run("capabilities-v1", new Date().toISOString());
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 关闭共享连接前归并 WAL，重复关闭安全 */
export function closeRuntimeDatabase(db: Database.Database): void {
  if (!db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
