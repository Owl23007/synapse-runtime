import type Database from "better-sqlite3";
import { RUNTIME_CONTEXT_POST_MIGRATION_SQL, RUNTIME_CONTEXT_SCHEMA_SQL } from "./schema.js";

export function migrateSqliteRuntimeContextStore(db: Database.Database): void {
  db.exec(RUNTIME_CONTEXT_SCHEMA_SQL);
  ensureColumn(db, "conversation_messages", "external_message_id", "TEXT");
  db.exec(RUNTIME_CONTEXT_POST_MIGRATION_SQL);
}

export function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }

  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}
