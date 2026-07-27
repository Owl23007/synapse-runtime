import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "./index.js";

describe("SqliteRuntimeContextStore migrations", () => {
  it("opens an old context database without external message ids and migrates idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-old-sqlite-"));
    const databasePath = join(dir, "runtime-context.sqlite");

    try {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          provider TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          conversation_type TEXT NOT NULL
            CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
          conversation_id TEXT NOT NULL,
          source_event_id TEXT,
          role TEXT NOT NULL
            CHECK(role IN ('user', 'assistant', 'system')),
          actor_id TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        );
      `);
      db.close();

      const firstOpen = new SqliteRuntimeContextStore({ databasePath });
      await firstOpen.append({
        sessionId: "qq:napcat:qq-local:private:user-1",
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "assistant-1",
        role: "assistant",
        text: "reply",
        externalMessageId: "sent-1",
        createdAt: new Date(0).toISOString()
      });
      firstOpen.close();

      const secondOpen = new SqliteRuntimeContextStore({ databasePath });
      await expect(
        secondOpen.findByExternalMessageId({
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          conversationType: "private",
          conversationId: "user-1",
          externalMessageId: "sent-1"
        })
      ).resolves.toMatchObject({ text: "reply" });
      secondOpen.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills populated legacy transcripts into one canonical mainline without duplicating on reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-populated-old-sqlite-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const sessionId = "qq:napcat:qq-local:private:user-1";

    try {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          provider TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          conversation_type TEXT NOT NULL
            CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
          conversation_id TEXT NOT NULL,
          source_event_id TEXT,
          role TEXT NOT NULL
            CHECK(role IN ('user', 'assistant', 'system')),
          actor_id TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        );

        INSERT INTO conversation_messages (
          id,
          session_id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          role,
          actor_id,
          text,
          created_at,
          deleted_at
        ) VALUES
          (
            'legacy-user-1',
            '${sessionId}',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-1',
            'source-user-1',
            'user',
            'user-1',
            'hello',
            '2026-07-26T08:00:00.000Z',
            NULL
          ),
          (
            'legacy-assistant-1',
            '${sessionId}',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-1',
            'source-assistant-1',
            'assistant',
            'agent-1',
            'hi',
            '2026-07-26T08:00:01.000Z',
            NULL
          );
      `);
      db.close();

      const firstOpen = new SqliteRuntimeContextStore({ databasePath });
      const firstMainline = await firstOpen.getMainline(sessionId);
      expect(firstMainline.id).toBe(`mainline:${sessionId}`);
      expect((await firstOpen.listLines(sessionId)).filter((line) => line.kind === "mainline")).toHaveLength(1);
      expect(await firstOpen.listEvents(firstMainline.id)).toMatchObject([
        {
          sequence: 1,
          type: "user_message",
          payload: expect.objectContaining({ segments: [{ type: "text", text: "hello" }] })
        },
        {
          sequence: 2,
          type: "assistant_message",
          payload: expect.objectContaining({ segments: [{ type: "text", text: "hi" }] })
        }
      ]);
      expect(await firstOpen.listNormalizedEvents(sessionId)).toMatchObject([
        {
          sourceEventId: "source-user-1",
          text: "hello",
          lineId: firstMainline.id
        }
      ]);
      expect(await firstOpen.listRecent(sessionId, { lineId: firstMainline.id })).toMatchObject([
        { id: "legacy-user-1", lineId: firstMainline.id, lineEventId: "line-event:legacy:legacy-user-1" },
        {
          id: "legacy-assistant-1",
          lineId: firstMainline.id,
          lineEventId: "line-event:legacy:legacy-assistant-1"
        }
      ]);
      const legacyUserTrace = await firstOpen.getEventTrace("line-event:legacy:legacy-user-1");
      expect(legacyUserTrace.event).toMatchObject({
        id: "line-event:legacy:legacy-user-1",
        sourceEventId: "source-user-1"
      });
      expect(legacyUserTrace.sourceEvent).toBeUndefined();
      expect(legacyUserTrace.causationChain.map((event) => event.id)).toEqual(["line-event:legacy:legacy-user-1"]);
      firstOpen.close();

      const secondOpen = new SqliteRuntimeContextStore({ databasePath });
      expect(await secondOpen.listNormalizedEvents(sessionId)).toHaveLength(1);
      expect(await secondOpen.listEvents(firstMainline.id)).toHaveLength(2);
      expect(await secondOpen.listRecent(sessionId, { lineId: firstMainline.id })).toHaveLength(2);
      secondOpen.close();

      const inspected = new Database(databasePath, { readonly: true });
      expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(inspected.pragma("user_version", { simple: true })).toBe(4);
      inspected.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves cross-routing legacy duplicates without attaching them to a missing normalized event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-routing-duplicate-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const firstSessionId = "qq:napcat:qq-local:private:user-1";
    const secondSessionId = "qq:napcat:qq-local:private:user-2";

    try {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          provider TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          conversation_type TEXT NOT NULL
            CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
          conversation_id TEXT NOT NULL,
          source_event_id TEXT,
          role TEXT NOT NULL
            CHECK(role IN ('user', 'assistant', 'system')),
          actor_id TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE UNIQUE INDEX idx_conv_source_event
        ON conversation_messages(
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id
        )
        WHERE source_event_id IS NOT NULL;

        INSERT INTO conversation_messages (
          id,
          session_id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          role,
          actor_id,
          text,
          created_at,
          deleted_at
        ) VALUES
          (
            'legacy-routing-1',
            '${firstSessionId}',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-1',
            'same-source-event',
            'user',
            'user-1',
            'first routing',
            '2026-07-26T08:00:00.000Z',
            NULL
          ),
          (
            'legacy-routing-2',
            '${secondSessionId}',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-2',
            'same-source-event',
            'user',
            'user-2',
            'replayed under another routing',
            '2026-07-26T08:00:01.000Z',
            NULL
          );
      `);
      db.close();

      const store = new SqliteRuntimeContextStore({ databasePath });
      try {
        const firstMainline = await store.getMainline(firstSessionId);
        const secondMainline = await store.getMainline(secondSessionId);
        expect(await store.listEvents(firstMainline.id)).toMatchObject([
          {
            sourceNormalizedEventId: "normalized:legacy:legacy-routing-1",
            sourceEventId: "same-source-event"
          }
        ]);
        const duplicateEvents = await store.listEvents(secondMainline.id);
        expect(duplicateEvents).toHaveLength(1);
        expect(duplicateEvents[0]).toMatchObject({ sourceEventId: "same-source-event" });
        expect(duplicateEvents[0]).not.toHaveProperty("sourceNormalizedEventId");
        expect(await store.listNormalizedEvents(firstSessionId)).toHaveLength(1);
        expect(await store.listNormalizedEvents(secondSessionId)).toHaveLength(0);
      } finally {
        store.close();
      }

      const inspected = new Database(databasePath, { readonly: true });
      try {
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM conversation_messages").get()).toEqual({ count: 2 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM line_events").get()).toEqual({ count: 2 });
        expect(inspected.prepare("SELECT COUNT(*) AS count FROM normalized_events").get()).toEqual({ count: 1 });
        expect(inspected.prepare("SELECT COUNT(source_normalized_event_id) AS count FROM line_events").get()).toEqual({
          count: 1
        });
        expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        inspected.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates event processing idempotency to include event type and collapse old routing duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-event-process-v2-"));
    const databasePath = join(dir, "runtime-context.sqlite");

    try {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE event_process_state (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          provider TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          conversation_type TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          status TEXT NOT NULL,
          incoming_message_id TEXT,
          assistant_message_id TEXT,
          agent_output_text TEXT,
          agent_output_json TEXT,
          send_result_json TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX idx_event_process_unique
        ON event_process_state(
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id
        );

        INSERT INTO event_process_state (
          id,
          platform,
          provider,
          channel_id,
          conversation_type,
          conversation_id,
          source_event_id,
          status,
          created_at,
          updated_at
        ) VALUES
          (
            'old-received',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-1',
            'source-1',
            'received',
            '2026-07-26T08:00:00.000Z',
            '2026-07-26T08:00:00.000Z'
          ),
          (
            'old-completed',
            'qq',
            'napcat',
            'qq-local',
            'private',
            'user-2',
            'source-1',
            'completed',
            '2026-07-26T08:00:01.000Z',
            '2026-07-26T08:00:01.000Z'
          );
      `);
      db.close();

      const store = new SqliteRuntimeContextStore({ databasePath });
      const created = await store.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-3",
        sourceEventId: "source-1",
        sourceEventType: "message.created"
      });
      const deleted = await store.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-3",
        sourceEventId: "source-1",
        sourceEventType: "message.deleted"
      });

      expect(created).toMatchObject({ id: "old-completed", status: "completed" });
      expect(deleted).toMatchObject({ status: "received" });
      expect(deleted.id).not.toBe(created.id);
      store.close();

      const inspected = new Database(databasePath, { readonly: true });
      expect(
        inspected
          .prepare(
            "SELECT source_event_type, COUNT(*) AS count FROM event_process_state GROUP BY source_event_type ORDER BY source_event_type"
          )
          .all()
      ).toEqual([
        { source_event_type: "message.created", count: 1 },
        { source_event_type: "message.deleted", count: 1 }
      ]);
      expect(inspected.pragma("user_version", { simple: true })).toBe(4);
      inspected.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
