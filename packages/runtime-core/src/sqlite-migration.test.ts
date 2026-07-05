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
});
