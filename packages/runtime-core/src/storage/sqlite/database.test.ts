import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openRuntimeDatabase, closeRuntimeDatabase } from "./database.js";
import { migrateSqliteRuntimeContextStore } from "./migrations.js";

function withDatabase(check: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-db-migration-"));
  try {
    check(join(directory, "runtime.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runtime database management", () => {
  it("upgrades a legacy v7 database once and preserves unrelated data", () => {
    withDatabase((path) => {
      const legacy = new Database(path);
      migrateSqliteRuntimeContextStore(legacy);
      legacy.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep')");
      legacy.close();
      const migrated = openRuntimeDatabase(path);
      const history = migrated.prepare("SELECT * FROM runtime_migrations ORDER BY id").all();
      expect(history).toHaveLength(2);
      expect(migrated.prepare("SELECT value FROM preserved").get()).toEqual({ value: "keep" });
      // 旧迁移若被重复运行，会删除并重建此索引
      migrated.exec(
        "CREATE TRIGGER forbid_index_rebuild BEFORE DELETE ON event_process_state BEGIN SELECT RAISE(ABORT, 'legacy migration repeated'); END"
      );
      closeRuntimeDatabase(migrated);
      const reopened = openRuntimeDatabase(path);
      try {
        expect(reopened.prepare("SELECT * FROM runtime_migrations ORDER BY id").all()).toEqual(history);
        expect(reopened.pragma("foreign_key_check")).toEqual([]);
      } finally {
        closeRuntimeDatabase(reopened);
      }
    });
  });

  it("rolls back all migration work on failure and releases the failed connection", () => {
    withDatabase((path) => {
      const legacy = new Database(path);
      legacy.exec("CREATE TABLE context_graph_commit (old_value TEXT)");
      legacy.close();
      expect(() => openRuntimeDatabase(path)).toThrow();
      const inspected = new Database(path);
      try {
        expect(
          inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_migrations'").get()
        ).toBeUndefined();
        expect(inspected.pragma("user_version", { simple: true })).toBe(0);
        expect(
          inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_sessions'").get()
        ).toBeUndefined();
      } finally {
        inspected.close();
      }
    });
  });

  it("rejects future database formats without downgrading them", () => {
    withDatabase((path) => {
      const future = openRuntimeDatabase(path);
      future.pragma("user_version = 99");
      closeRuntimeDatabase(future);
      expect(() => openRuntimeDatabase(path)).toThrow("Unsupported");
      const inspected = new Database(path);
      try {
        expect(inspected.pragma("user_version", { simple: true })).toBe(99);
      } finally {
        inspected.close();
      }
    });
  });
});
