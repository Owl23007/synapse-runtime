import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";

// 旧语义 Head 契约迁移到唯一 Context Commit / Ref 内核
describe("会话显式上下文版本", () => {
  it("事件和结果不产生隐式版本，显式快照与历史分叉在重启后保持稳定", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-explicit-context-"));
    const databasePath = join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath });
    onTestFinished(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const accepted = await store.acceptNormalizedEvent({
      sessionId: "session",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "cli",
      conversationId: "session",
      sourceEventId: "source",
      sourceEventType: "message.created",
      senderId: "human",
      text: "研究",
      receivedAt: new Date().toISOString(),
      idempotencyKey: "input"
    });
    const graph = store.contextGraph;
    expect(graph.getRef("session", "main")).toBeUndefined();
    const rootInput = {
      scopeId: "session",
      refName: "main",
      expectedVersion: null,
      idempotencyKey: "root",
      type: "decision",
      content: { decision: "采用分段缓冲" }
    } as const;
    const root = graph.commit(rootInput);
    graph.fork("session", "investigation", root.id);
    const evidence = await store.appendEvent(accepted.mainline.id, {
      type: "tool_result",
      payload: { receipt: "confirmed" },
      idempotencyKey: "receipt"
    });
    expect(graph.getRef("session", "main")?.commitId).toBe(root.id);
    const revisedInput = {
      ...rootInput,
      refName: "investigation",
      expectedVersion: 1,
      idempotencyKey: "revised",
      content: { decision: "保留来源和确认回执", sourceEventId: evidence.id }
    };
    const revised = graph.commit(revisedInput);
    expect(graph.getCommit("session", root.id)?.content).toEqual({ decision: "采用分段缓冲" });
    expect(() => graph.commit({ ...revisedInput, idempotencyKey: "conflict" })).toThrow(/version conflict/);
    store.close();
    store = new SqliteRuntimeContextStore({ databasePath });
    expect(store.contextGraph.commit(revisedInput)).toEqual(revised);
    expect(store.contextGraph.commit(rootInput)).toEqual(root);
    expect(store.contextGraph.getRef("session", "investigation")).toMatchObject({ commitId: revised.id, version: 2 });
    expect(store.contextGraph.getCommit("other", revised.id)).toBeUndefined();
    expect(await store.getEvent(evidence.id)).toEqual(evidence);
    expect(await store.listEvents(accepted.mainline.id)).toHaveLength(2);
  });
});
