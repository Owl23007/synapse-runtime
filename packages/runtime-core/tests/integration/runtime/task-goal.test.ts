import { describe, expect, it, onTestFinished } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";

async function fixture(settings: { maxTasks?: number; maxTaskDepth?: number } = {}) {
  const store = new SqliteRuntimeContextStore({ databasePath: ":memory:", autonomy: settings });
  onTestFinished(() => store.close());
  await store.bindProjectWorkspace({ workspaceId: "project", identityId: "owner" });
  const grant = store.execution.issueGrant({
    key: "goal",
    workspaceId: "project",
    principalId: "owner",
    source: { platform: "cli", channelId: "background", conversationId: "project", conversationKind: "system" }
  });
  const create = (key = "goal", parentId?: string) =>
    store.execution.createTask(grant, {
      key,
      goal: "持续研究",
      acceptance: "可靠证据",
      ...(parentId ? { parentId } : {})
    });
  return { store, grant, create };
}

describe("持久目标与单次执行独立", () => {
  it("目标无需 Session、Branch 或 executor，创建幂等且不产生上下文节点", async () => {
    const { store, grant, create } = await fixture();
    const task = create();
    expect(create()).toEqual(task);
    expect(store.inspectSessions()).toHaveLength(0);
    expect(store.runs.list().items).toHaveLength(0);
    expect(store.execution.contextRefs(`private:project:${grant.principalId}`)).toHaveLength(0);
    expect(task).toMatchObject({ revision: 1, status: "open", goal: "持续研究", acceptance: "可靠证据" });
  });

  it("Run 失败不会把 Task 标记失败，后续 Run 仍能推进", async () => {
    const { store, grant, create } = await fixture();
    const task = create();
    const first = store.execution.advanceTask(grant, { id: task.id, key: "first", instruction: "推进" });
    store.execution.claim(first.id);
    store.runs.append(first.runId, { key: "failed", type: "run_failed", status: "failed" });
    store.execution.finish(first.id);
    expect(store.execution.getTask(task.id, grant).status).toBe("open");
    const next = store.execution.advanceTask(grant, { id: task.id, key: "next", instruction: "继续" });
    expect(next.runId).not.toBe(first.runId);
    expect(store.execution.claim(next.id)).toBeDefined();
  });

  it("暂停阻止领取排队工作，过期 revision 不能覆盖当前目标", async () => {
    const { store, grant, create } = await fixture();
    const task = create();
    const intent = store.execution.advanceTask(grant, { id: task.id, key: "queued", instruction: "推进" });
    expect(store.execution.controlTask(task.id, 1, "paused").revision).toBe(2);
    expect(store.execution.claim(intent.id)).toBeUndefined();
    expect(() => store.execution.controlTask(task.id, 1, "cancelled")).toThrow(/revision/);
    expect(store.execution.getTask(task.id, grant).status).toBe("paused");
  });

  it("取消是终态，迟到工作和恢复不能重新打开目标", async () => {
    const { store, grant, create } = await fixture();
    const task = create();
    store.execution.controlTask(task.id, 1, "cancelled");
    expect(() => store.execution.advanceTask(grant, { id: task.id, key: "late", instruction: "继续" })).toThrow(
      /not open/
    );
    expect(() => store.execution.controlTask(task.id, 2, "open")).toThrow(/terminal/);
    store.recoverRuns();
    expect(store.execution.getTask(task.id, grant).status).toBe("cancelled");
  });

  it("目标总量与父子深度均由宿主限制", async () => {
    const { create } = await fixture({ maxTasks: 2, maxTaskDepth: 1 });
    const parent = create();
    expect(() => create("child", parent.id)).toThrow(/depth/);
    create("independent");
    expect(() => create("overflow")).toThrow(/quota/);
  });

  it("目标修订后显式读取才采用新版本，旧产出保留但不能完成新目标", async () => {
    const { store, grant, create } = await fixture();
    const task = create();
    const run = store.execution.advanceTask(grant, { id: task.id, key: "run", instruction: "推进" });
    store.execution.claim(run.id);
    store.execution.updateTask(grant, { id: task.id, expectedRevision: 1, goal: "修订后的目标" });
    const conflict = store.execution.updateTask(grant, {
      id: task.id,
      expectedRevision: 1,
      status: "completed",
      result: { runId: run.runId, revision: 1, content: "旧产出" }
    });
    expect(conflict.conflict).toBe(true);
    expect(conflict.task.results).toHaveLength(1);
    expect(store.execution.readTask(run.runId, task.id).revision).toBe(2);
    expect(store.execution.forRun(run.runId)?.taskRevision).toBe(2);
    expect(store.execution.getTask(task.id, grant).status).toBe("open");
    const completed = store.execution.updateTask(grant, {
      id: task.id,
      expectedRevision: 2,
      status: "completed",
      result: { runId: run.runId, revision: 2, content: "新目标的有效产出" }
    });
    expect(completed.conflict).toBe(false);
    expect(completed.task.results.map((result) => result.revision)).toEqual([1, 2]);
    expect(completed.task.completedByRunId).toBe(run.runId);
  });
});
