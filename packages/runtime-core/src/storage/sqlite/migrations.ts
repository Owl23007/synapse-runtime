import type Database from "better-sqlite3";
import {
  RUNTIME_CONTEXT_MEMORY_POST_MIGRATION_SQL,
  RUNTIME_CONTEXT_POST_MIGRATION_SQL,
  RUNTIME_CONTEXT_SCHEMA_SQL
} from "./schema.js";

/**
 * 幂等迁移运行时上下文数据库
 */
export function migrateSqliteRuntimeContextStore(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(RUNTIME_CONTEXT_SCHEMA_SQL);
    ensureColumn(db, "conversation_messages", "line_id", "TEXT");
    ensureColumn(db, "conversation_messages", "normalized_event_id", "TEXT");
    ensureColumn(db, "conversation_messages", "line_event_id", "TEXT");
    ensureColumn(db, "conversation_messages", "message_json", "TEXT");
    ensureColumn(db, "conversation_messages", "raw_payload_json", "TEXT");
    ensureColumn(db, "conversation_messages", "event_type", "TEXT");
    ensureColumn(db, "conversation_messages", "idempotency_key", "TEXT");
    ensureColumn(db, "conversation_messages", "external_message_id", "TEXT");
    ensureColumn(db, "event_process_state", "source_event_type", "TEXT NOT NULL DEFAULT 'message.created'");
    ensureColumn(db, "memory_records", "kind", "TEXT NOT NULL DEFAULT 'preference'");
    ensureColumn(db, "memory_records", "importance", "REAL NOT NULL DEFAULT 0.5");
    ensureColumn(db, "memory_records", "confidence", "REAL NOT NULL DEFAULT 0.8");
    ensureColumn(db, "memory_records", "pii_level", "TEXT NOT NULL DEFAULT 'none'");
    ensureColumn(db, "memory_records", "prompt_eligible", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "memory_records", "idempotency_key", "TEXT");
    rebuildWorkspaceTypeCheck(db);
    backfillLegacyConversationModel(db);
    rebuildEventProcessUniqueIndex(db);
    db.exec(RUNTIME_CONTEXT_POST_MIGRATION_SQL);
    db.exec(RUNTIME_CONTEXT_MEMORY_POST_MIGRATION_SQL);

    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length > 0) {
      throw new Error(`Runtime context migration produced ${foreignKeyErrors.length} foreign key violation(s).`);
    }
    db.pragma("user_version = 7");
  });

  migrate.immediate();
}

function rebuildWorkspaceTypeCheck(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get() as
    | { readonly sql?: string }
    | undefined;
  if (row?.sql?.includes("'project'") === true) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_workspace_binding_identity;
    DROP INDEX IF EXISTS idx_workspace_binding_conversation;
    DROP INDEX IF EXISTS idx_memory_scope_created;
    DROP INDEX IF EXISTS idx_memory_visibility;
    DROP INDEX IF EXISTS idx_memory_idempotency;
    ALTER TABLE workspaces RENAME TO workspaces_legacy_v6;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('personal', 'group', 'project', 'system')),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO workspaces (id, type, name, created_at, updated_at, deleted_at)
      SELECT id, type, name, created_at, updated_at, deleted_at FROM workspaces_legacy_v6;
    ALTER TABLE memory_records RENAME TO memory_records_legacy_v6;
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('identity', 'workspace')),
      scope_id TEXT NOT NULL,
      identity_id TEXT,
      workspace_id TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'workspace', 'public', 'secret')),
      kind TEXT NOT NULL DEFAULT 'preference' CHECK(kind IN ('preference', 'fact', 'decision', 'summary')),
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      idempotency_key TEXT,
      importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL DEFAULT 0.8 CHECK(confidence >= 0 AND confidence <= 1),
      pii_level TEXT NOT NULL DEFAULT 'none' CHECK(pii_level IN ('none', 'low', 'high')),
      prompt_eligible INTEGER NOT NULL DEFAULT 1 CHECK(prompt_eligible IN (0, 1)),
      source_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK(
        (scope_type = 'identity' AND identity_id IS NOT NULL AND workspace_id IS NULL)
        OR
        (scope_type = 'workspace' AND identity_id IS NULL AND workspace_id IS NOT NULL)
      ),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
    INSERT INTO memory_records (
      id, scope_type, scope_id, identity_id, workspace_id, visibility, kind, content, source,
      idempotency_key, importance, confidence, pii_level, prompt_eligible, source_event_id,
      created_at, updated_at, deleted_at
    ) SELECT id, scope_type, scope_id, identity_id, workspace_id, visibility, kind, content, source,
      idempotency_key, importance, confidence, pii_level, prompt_eligible, source_event_id,
      created_at, updated_at, deleted_at FROM memory_records_legacy_v6;
    DROP TABLE memory_records_legacy_v6;
    ALTER TABLE workspace_bindings RENAME TO workspace_bindings_legacy_v6;
    CREATE TABLE workspace_bindings (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      binding_type TEXT NOT NULL CHECK(binding_type IN ('identity', 'conversation')),
      identity_id TEXT,
      platform TEXT,
      provider TEXT,
      channel_id TEXT,
      conversation_type TEXT CHECK(conversation_type IS NULL OR conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK(
        (binding_type = 'identity' AND identity_id IS NOT NULL AND platform IS NULL AND provider IS NULL AND channel_id IS NULL AND conversation_type IS NULL AND conversation_id IS NULL)
        OR
        (binding_type = 'conversation' AND identity_id IS NULL AND platform IS NOT NULL AND provider IS NOT NULL AND channel_id IS NOT NULL AND conversation_type IS NOT NULL AND conversation_id IS NOT NULL)
      ),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
    INSERT INTO workspace_bindings (
      id, workspace_id, binding_type, identity_id, platform, provider, channel_id,
      conversation_type, conversation_id, created_at, deleted_at
    ) SELECT id, workspace_id, binding_type, identity_id, platform, provider, channel_id,
      conversation_type, conversation_id, created_at, deleted_at FROM workspace_bindings_legacy_v6;
    DROP TABLE workspace_bindings_legacy_v6;
    DROP TABLE workspaces_legacy_v6;
    CREATE INDEX idx_memory_scope_created ON memory_records(scope_type, scope_id, created_at DESC);
    CREATE INDEX idx_memory_visibility ON memory_records(visibility, identity_id, workspace_id, deleted_at);
    CREATE UNIQUE INDEX idx_workspace_binding_identity
      ON workspace_bindings(workspace_id, identity_id)
      WHERE binding_type = 'identity' AND deleted_at IS NULL;
    CREATE UNIQUE INDEX idx_workspace_binding_conversation
      ON workspace_bindings(workspace_id, platform, provider, channel_id, conversation_type, conversation_id)
      WHERE binding_type = 'conversation' AND deleted_at IS NULL;
  `);
}

/**
 * 在字段缺失时为 SQLite 表追加字段
 */
export function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }

  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function rebuildEventProcessUniqueIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM event_process_state
    WHERE rowid IN (
      SELECT row_id
      FROM (
        SELECT
          rowid AS row_id,
          ROW_NUMBER() OVER (
            PARTITION BY platform, provider, channel_id, source_event_id, source_event_type
            ORDER BY
              CASE status
                WHEN 'completed' THEN 70
                WHEN 'send_succeeded' THEN 60
                WHEN 'send_failed' THEN 50
                WHEN 'agent_completed' THEN 40
                WHEN 'processing' THEN 30
                ELSE 20
              END DESC,
              updated_at DESC,
              rowid DESC
          ) AS duplicate_rank
        FROM event_process_state
      )
      WHERE duplicate_rank > 1
    );

    DROP INDEX IF EXISTS idx_event_process_unique;
  `);
}

interface LegacyMessageRow {
  readonly row_id: number;
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string | null;
  readonly normalized_event_id: string | null;
  readonly line_event_id: string | null;
  readonly event_type: string | null;
  readonly idempotency_key: string | null;
  readonly platform: string;
  readonly provider: string;
  readonly channel_id: string;
  readonly conversation_type: string;
  readonly conversation_id: string;
  readonly source_event_id: string | null;
  readonly role: "user" | "assistant" | "system";
  readonly actor_id: string | null;
  readonly text: string;
  readonly created_at: string;
  readonly external_message_id: string | null;
}

function backfillLegacyConversationModel(db: Database.Database): void {
  const rows = db
    .prepare(`
      SELECT rowid AS row_id, *
      FROM conversation_messages
      ORDER BY created_at, rowid
    `)
    .all() as LegacyMessageRow[];
  const sessions = new Map<string, LegacyMessageRow[]>();

  for (const row of rows) {
    const sessionRows = sessions.get(row.session_id) ?? [];
    sessionRows.push(row);
    sessions.set(row.session_id, sessionRows);
  }

  for (const [sessionId, sessionRows] of sessions) {
    const first = sessionRows[0];
    if (first === undefined) {
      continue;
    }
    assertConsistentLegacySession(sessionId, sessionRows, first);

    const mainlineId = `mainline:${sessionId}`;
    const createdAt = first.created_at;
    db.prepare(`
      INSERT OR IGNORE INTO conversation_sessions (
        id,
        platform,
        provider,
        channel_id,
        conversation_type,
        conversation_id,
        status,
        mainline_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      sessionId,
      first.platform,
      first.provider,
      first.channel_id,
      first.conversation_type,
      first.conversation_id,
      mainlineId,
      createdAt,
      sessionRows.at(-1)?.created_at ?? createdAt
    );
    assertStoredSessionMatches(db, sessionId, mainlineId, first);

    db.prepare(`
      INSERT OR IGNORE INTO conversation_lines (
        id,
        session_id,
        kind,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, 'mainline', 'active', ?, ?)
    `).run(mainlineId, sessionId, createdAt, sessionRows.at(-1)?.created_at ?? createdAt);

    let nextSequence = currentLineSequence(db, mainlineId);
    for (const row of sessionRows) {
      if (row.line_event_id !== null) {
        db.prepare(`
          UPDATE conversation_messages
          SET line_id = COALESCE(line_id, ?)
          WHERE id = ?
        `).run(mainlineId, row.id);
        continue;
      }

      const existingProjection = findExistingCanonicalProjection(db, row, mainlineId);
      if (existingProjection !== undefined) {
        db.prepare(`
          UPDATE conversation_messages
          SET line_id = ?,
              normalized_event_id = ?,
              line_event_id = ?
          WHERE id = ?
        `).run(
          existingProjection.lineId,
          existingProjection.normalizedEventId ?? null,
          existingProjection.lineEventId,
          row.id
        );
        continue;
      }

      const messageJson = JSON.stringify({
        ...(row.external_message_id === null ? {} : { id: row.external_message_id }),
        type: "text",
        segments: [{ type: "text", text: row.text }]
      });
      let normalizedEventId =
        row.role === "user" && row.source_event_id !== null ? `normalized:legacy:${row.id}` : undefined;

      if (normalizedEventId !== undefined) {
        db.prepare(`
          INSERT OR IGNORE INTO normalized_events (
            id,
            session_id,
            platform,
            provider,
            channel_id,
            conversation_type,
            conversation_id,
            source_event_id,
            source_message_id,
            source_event_type,
            sender_id,
            text,
            message_json,
            segments_json,
            received_at,
            ingested_at,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'message.created', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedEventId,
          sessionId,
          row.platform,
          row.provider,
          row.channel_id,
          row.conversation_type,
          row.conversation_id,
          row.source_event_id,
          row.external_message_id,
          row.actor_id ?? "legacy:unknown",
          row.text,
          messageJson,
          JSON.stringify([{ type: "text", text: row.text }]),
          row.created_at,
          row.created_at,
          `legacy-normalized:${row.id}`
        );

        const storedNormalized = db
          .prepare(`
            SELECT id
            FROM normalized_events
            WHERE platform = ?
              AND provider = ?
              AND channel_id = ?
              AND source_event_id = ?
              AND source_event_type = 'message.created'
            LIMIT 1
          `)
          .get(row.platform, row.provider, row.channel_id, row.source_event_id) as { readonly id: string } | undefined;
        if (storedNormalized === undefined) {
          throw new Error(`Legacy normalized event for transcript "${row.id}" was not persisted.`);
        }
        if (storedNormalized.id !== normalizedEventId) {
          // Preserve the legacy transcript and its line event, but do not attach a
          // cross-session duplicate to the canonical normalized event.
          normalizedEventId = undefined;
        }
      }

      nextSequence += 1;
      const lineEventId = `line-event:legacy:${row.id}`;
      const eventType = roleEventType(row.role);
      const idempotencyKey = `legacy-message:${row.id}`;
      db.prepare(`
        INSERT OR IGNORE INTO line_events (
          id,
          session_id,
          line_id,
          sequence,
          type,
          role,
          actor_id,
          text,
          payload_json,
          source_normalized_event_id,
          source_event_id,
          idempotency_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lineEventId,
        sessionId,
        mainlineId,
        nextSequence,
        eventType,
        row.role,
        row.actor_id,
        row.text,
        messageJson,
        normalizedEventId ?? null,
        row.source_event_id,
        idempotencyKey,
        row.created_at
      );
      db.prepare(`
        UPDATE conversation_messages
        SET line_id = ?,
            normalized_event_id = ?,
            line_event_id = ?,
            message_json = COALESCE(message_json, ?),
            event_type = COALESCE(event_type, ?),
            idempotency_key = COALESCE(idempotency_key, ?)
        WHERE id = ?
      `).run(mainlineId, normalizedEventId ?? null, lineEventId, messageJson, eventType, idempotencyKey, row.id);
    }
  }
}

function findExistingCanonicalProjection(
  db: Database.Database,
  row: LegacyMessageRow,
  mainlineId: string
):
  | {
      readonly lineId: string;
      readonly lineEventId: string;
      readonly normalizedEventId?: string;
    }
  | undefined {
  const lineId = row.line_id ?? mainlineId;

  if (row.idempotency_key !== null) {
    const lineEvent = db
      .prepare(`
        SELECT id, line_id, source_normalized_event_id
        FROM line_events
        WHERE line_id = ? AND idempotency_key = ?
      `)
      .get(lineId, row.idempotency_key) as
      | {
          readonly id: string;
          readonly line_id: string;
          readonly source_normalized_event_id: string | null;
        }
      | undefined;
    if (lineEvent !== undefined) {
      return {
        lineId: lineEvent.line_id,
        lineEventId: lineEvent.id,
        ...(lineEvent.source_normalized_event_id === null
          ? {}
          : { normalizedEventId: lineEvent.source_normalized_event_id })
      };
    }

    const normalizedProjection = db
      .prepare(`
        SELECT
          line_events.id AS line_event_id,
          line_events.line_id,
          normalized_events.id AS normalized_event_id
        FROM normalized_events
        INNER JOIN line_events
          ON line_events.source_normalized_event_id = normalized_events.id
        WHERE normalized_events.session_id = ?
          AND normalized_events.idempotency_key = ?
      `)
      .get(row.session_id, row.idempotency_key) as
      | {
          readonly line_event_id: string;
          readonly line_id: string;
          readonly normalized_event_id: string;
        }
      | undefined;
    if (normalizedProjection !== undefined) {
      return {
        lineId: normalizedProjection.line_id,
        lineEventId: normalizedProjection.line_event_id,
        normalizedEventId: normalizedProjection.normalized_event_id
      };
    }
  }

  return undefined;
}

function assertConsistentLegacySession(
  sessionId: string,
  rows: readonly LegacyMessageRow[],
  expected: LegacyMessageRow
): void {
  const conflict = rows.find(
    (row) =>
      row.platform !== expected.platform ||
      row.provider !== expected.provider ||
      row.channel_id !== expected.channel_id ||
      row.conversation_type !== expected.conversation_type ||
      row.conversation_id !== expected.conversation_id
  );
  if (conflict !== undefined) {
    throw new Error(`Legacy session "${sessionId}" maps to more than one channel conversation.`);
  }
}

function assertStoredSessionMatches(
  db: Database.Database,
  sessionId: string,
  mainlineId: string,
  expected: LegacyMessageRow
): void {
  const stored = db
    .prepare(`
      SELECT platform, provider, channel_id, conversation_type, conversation_id, mainline_id
      FROM conversation_sessions
      WHERE id = ?
    `)
    .get(sessionId) as
    | {
        readonly platform: string;
        readonly provider: string;
        readonly channel_id: string;
        readonly conversation_type: string;
        readonly conversation_id: string;
        readonly mainline_id: string;
      }
    | undefined;

  if (
    stored === undefined ||
    stored.platform !== expected.platform ||
    stored.provider !== expected.provider ||
    stored.channel_id !== expected.channel_id ||
    stored.conversation_type !== expected.conversation_type ||
    stored.conversation_id !== expected.conversation_id ||
    stored.mainline_id !== mainlineId
  ) {
    throw new Error(`Session "${sessionId}" conflicts with the existing persisted conversation.`);
  }
}

function currentLineSequence(db: Database.Database, lineId: string): number {
  const row = db
    .prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM line_events
      WHERE line_id = ?
    `)
    .get(lineId) as { readonly sequence: number };
  return row.sequence;
}

function roleEventType(role: LegacyMessageRow["role"]): string {
  if (role === "user") {
    return "user_message";
  }
  if (role === "assistant") {
    return "assistant_message";
  }
  return "system_message";
}
