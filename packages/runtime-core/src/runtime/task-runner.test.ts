import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../conversation/index.js";
import { TaskRunner } from "./task-runner.js";

async function branchFixture(store: InMemoryConversationStore, suffix: string) {
  const accepted = await store.acceptNormalizedEvent({
    sessionId: `session-${suffix}`,
    platform: "test",
    provider: "test",
    channelId: "test",
    conversationType: "private",
    conversationId: `conversation-${suffix}`,
    sourceEventId: `source-${suffix}`,
    sourceEventType: "message.created",
    senderId: "user",
    text: "run",
    receivedAt: "2026-07-29T00:00:00.000Z",
    idempotencyKey: `accept-${suffix}`
  });
  const branch = await store.createBranch({
    sessionId: accepted.session.id,
    sourceEventId: accepted.lineEvent.id,
    title: "Test branch",
    goal: "Exercise the task runner",
    reason: "test",
    createdBy: "test",
    idempotencyKey: `branch-${suffix}`
  });
  return { accepted, branch };
}

describe("TaskRunner", () => {
  it("persists a successful task, result, and mainline publication", async () => {
    const store = new InMemoryConversationStore();
    const { accepted, branch } = await branchFixture(store, "success");
    const runner = new TaskRunner({
      store,
      executors: {
        echo: async (input) => ({
          output: input,
          summary: "Task completed.",
          artifacts: [{ path: "result.json" }],
          nextActions: ["Review result"]
        })
      }
    });

    const task = await runner.start(branch.id, {
      executor: "echo",
      input: { value: 1 },
      idempotencyKey: "task-success"
    });
    const result = await runner.wait(task.id);

    expect(await store.getTask(task.id)).toMatchObject({ status: "completed", output: { value: 1 } });
    expect(result).toMatchObject({
      status: "completed",
      summary: "Task completed.",
      sourceTaskIds: [task.id]
    });
    expect(await store.getBranch(branch.id)).toMatchObject({ status: "completed", mergedAt: expect.any(String) });
    expect(await store.listEvents(accepted.mainline.id)).toContainEqual(
      expect.objectContaining({ type: "branch_result" })
    );
  });

  it("persists cancellation and publishes a cancelled result", async () => {
    const store = new InMemoryConversationStore();
    const { branch } = await branchFixture(store, "cancel");
    let release: (() => void) | undefined;
    const runner = new TaskRunner({
      store,
      executors: {
        slow: (_input, context) =>
          new Promise((_resolve, reject) => {
            release = () => reject(context.signal.reason ?? new Error("aborted"));
          })
      }
    });

    const task = await runner.start(branch.id, {
      executor: "slow",
      input: {},
      idempotencyKey: "task-cancel"
    });
    await Promise.resolve();
    await expect(runner.cancel(task.id)).resolves.toMatchObject({ status: "cancelled" });
    release?.();
    await expect(runner.wait(task.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(await store.getBranch(branch.id)).toMatchObject({ status: "cancelled" });
    expect(await store.listBranchResults(branch.id)).toContainEqual(
      expect.objectContaining({ status: "cancelled", sourceTaskIds: [task.id] })
    );
  });

  it("resumes pending work but fails uncertain active work during recovery", async () => {
    const store = new InMemoryConversationStore();
    const pendingFixture = await branchFixture(store, "pending");
    const activeFixture = await branchFixture(store, "active");
    const pending = await store.createTask(pendingFixture.branch.id, {
      executor: "echo",
      input: "pending",
      idempotencyKey: "task-pending"
    });
    const active = await store.createTask(activeFixture.branch.id, {
      executor: "echo",
      input: "active",
      idempotencyKey: "task-active"
    });
    await store.transitionTask(active.id, {
      status: "running",
      idempotencyKey: "task-active-running"
    });
    const runner = new TaskRunner({
      store,
      executors: {
        echo: async (input) => ({ output: input, summary: "Recovered." })
      }
    });

    const recovery = await runner.recover();
    expect(recovery).toEqual({ resumedTaskIds: [pending.id], failedTaskIds: [active.id] });
    await runner.wait(pending.id);
    expect(await store.getTask(active.id)).toMatchObject({
      status: "failed",
      error: { code: "outcome_uncertain" }
    });
    expect(await store.listBranchResults(activeFixture.branch.id)).toContainEqual(
      expect.objectContaining({ status: "failed", sourceTaskIds: [active.id] })
    );
  });
});
