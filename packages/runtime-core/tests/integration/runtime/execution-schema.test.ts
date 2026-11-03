import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../src/storage/sqlite/database.js";

describe("执行存储版本演进", () => {
  it("升级旧执行表时保留目标、待办和运行身份", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-execution-schema-"));
    const databasePath = join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath });
    try {
      await store.bindProjectWorkspace({ workspaceId: "project", identityId: "owner" });
      const grant = store.execution.issueGrant({
        key: "grant",
        workspaceId: "project",
        principalId: "owner",
        source: { platform: "native", channelId: "native", conversationId: "project", conversationKind: "system" }
      });
      const task = store.execution.createTask(grant, { key: "task", goal: "原有目标", acceptance: "完成" });
      const intent = store.execution.advanceTask(grant, { id: task.id, key: "run", instruction: "推进" });
      store.close();
      const database = openRuntimeDatabase(databasePath);
      try {
        database.exec(
          "DROP INDEX intent_due; ALTER TABLE execution_intents DROP COLUMN next_attempt_at; DROP TABLE execution_input_receipts; DROP TABLE execution_schema; CREATE TABLE execution_schema (version INTEGER PRIMARY KEY CHECK(version = 1)); INSERT INTO execution_schema VALUES (1)"
        );
      } finally {
        closeRuntimeDatabase(database);
      }
      store = new SqliteRuntimeContextStore({ databasePath });
      expect(store.execution.getTask(task.id, grant)).toEqual(task);
      expect(store.execution.pending()).toMatchObject([{ id: intent.id, runId: intent.runId, availableAt: 0 }]);
      expect(store.execution.claim(intent.id)?.attempts).toBe(1);
      expect(store.runs.get(intent.runId)?.status).toBe("accepted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
