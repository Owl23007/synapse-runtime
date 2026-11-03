import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";

describe("持久模型退避", () => {
  it("重启保留退避时刻、Run 身份和累计模型额度", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-retry-state-"));
    const databasePath = join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath, autonomy: { maxModelCallsPerRun: 2 } });
    try {
      await store.bindProjectWorkspace({ workspaceId: "project", identityId: "owner" });
      const grant = store.execution.issueGrant({
        key: "grant",
        workspaceId: "project",
        principalId: "owner",
        source: { platform: "native", channelId: "native", conversationId: "project", conversationKind: "system" }
      });
      const task = store.execution.createTask(grant, { key: "task", goal: "目标", acceptance: "完成" });
      const intent = store.execution.advanceTask(grant, { id: task.id, key: "run", instruction: "推进" });
      store.execution.claim(intent.id);
      store.runs.append(intent.runId, { key: "first", type: "run_started", status: "running" });
      store.execution.consume(intent.runId, "model");
      const now = Date.now();
      expect(
        store.execution.retryModel(intent.runId, "first", { kind: "model", code: "http", retryable: true }, now)
      ).toBe(true);
      const due = store.execution.forRun(intent.runId)!.availableAt;
      expect(due).toBe(now + 1000);
      store.close();
      store = new SqliteRuntimeContextStore({ databasePath, autonomy: { maxModelCallsPerRun: 2 } });
      store.recoverRuns();
      expect(store.execution.runnable(10, due - 1)).toEqual([]);
      expect(store.execution.claim(intent.id, due - 1)).toBeUndefined();
      expect(store.execution.claim(intent.id, due)).toMatchObject({ runId: intent.runId, attempts: 2 });
      store.runs.append(intent.runId, { key: "second", type: "run_resumed", status: "running" });
      store.execution.consume(intent.runId, "model");
      expect(
        store.execution.retryModel(intent.runId, "second", { kind: "model", code: "http", retryable: true }, due)
      ).toBe(false);
      expect(() => store.execution.consume(intent.runId, "model")).toThrow(/budget/);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
