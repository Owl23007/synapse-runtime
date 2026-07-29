import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptNormalizedEventInput, ConversationStore } from "../types.js";

export interface ConversationStoreContractHarness {
  readonly store: ConversationStore;
  readonly close: () => void;
}

export type ConversationStoreContractFactory = () => ConversationStoreContractHarness;

/** 注册会话存储共享契约测试 */
export function registerConversationStoreContract(name: string, createHarness: ConversationStoreContractFactory): void {
  describe(`${name} conversation store contract`, () => {
    let harness: ConversationStoreContractHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    afterEach(() => {
      harness.close();
    });

    it("atomically accepts a normalized event into the default mainline and deduplicates it", async () => {
      const { store } = harness;
      const input = normalizedInput();

      const first = await store.acceptNormalizedEvent(input);
      const duplicate = await store.acceptNormalizedEvent(input);

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.event.id).toBe(first.event.id);
      expect(duplicate.lineEvent.id).toBe(first.lineEvent.id);
      expect(first.session.mainlineId).toBe(first.mainline.id);
      expect(first.lineEvent.lineId).toBe(first.mainline.id);
      expect(await store.listNormalizedEvents(first.session.id)).toEqual([first.event]);
      expect(await store.listEvents(first.mainline.id)).toEqual([first.lineEvent]);
    });

    it("rejects an idempotency key reused with different normalized content", async () => {
      const { store } = harness;
      const input = normalizedInput();
      await store.acceptNormalizedEvent(input);

      await expect(store.acceptNormalizedEvent({ ...input, text: "changed" })).rejects.toMatchObject({
        code: "idempotency_conflict"
      });
    });

    it("deduplicates a source event across changed conversation routing while keeping event types distinct", async () => {
      const { store } = harness;
      const input = normalizedInput();
      const accepted = await store.acceptNormalizedEvent(input);

      await expect(
        store.acceptNormalizedEvent({
          ...input,
          sessionId: "qq:napcat:qq-local:private:user-2",
          conversationId: "user-2",
          idempotencyKey: "replayed-under-another-conversation"
        })
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      const correction = await store.acceptNormalizedEvent({
        ...input,
        sourceEventType: "message.deleted",
        lineEventType: "correction",
        text: "",
        idempotencyKey: "qq\u001fqq-local\u001fmessage-1\u001fmessage.deleted"
      });

      expect(correction.created).toBe(true);
      expect(correction.event.id).not.toBe(accepted.event.id);
      expect(await store.listNormalizedEvents(accepted.session.id)).toHaveLength(2);
    });

    it("keeps branch execution isolated and publishes only a structured result reference", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const branch = await store.createBranch({
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Analyze parser",
        goal: "Find the parser bottleneck",
        reason: "Long-running analysis",
        createdBy: "agent",
        idempotencyKey: "branch-request-1",
        contextSnapshot: { background: "Only the relevant mainline fact" }
      });
      await store.transitionBranch(branch.id, {
        status: "active",
        idempotencyKey: "branch-active-1"
      });
      const toolEvent = await store.appendEvent(branch.id, {
        type: "tool_result",
        idempotencyKey: "tool-result-1",
        payload: { raw: "large intermediate output" }
      });
      const task = await store.createTask(branch.id, {
        executor: "repository-analyzer",
        input: { path: "src/parser.ts" },
        sourceEventId: toolEvent.id,
        idempotencyKey: "task-request-1"
      });
      await store.transitionTask(task.id, {
        status: "running",
        idempotencyKey: "task-running-1"
      });
      await store.transitionTask(task.id, {
        status: "completed",
        output: { bottleneck: "buffer concatenation" },
        artifacts: [{ path: "report.md" }],
        idempotencyKey: "task-completed-1"
      });
      const result = await store.createBranchResult(branch.id, {
        status: "completed",
        summary: "Repeated buffer concatenation is the bottleneck.",
        artifacts: [{ path: "report.md" }],
        citations: [{ eventId: toolEvent.id }],
        nextActions: ["Use segmented buffers"],
        sourceTaskIds: [task.id],
        idempotencyKey: "result-1"
      });
      const resultNodes = await store.listNodes(branch.id, { kinds: ["task_result"] });
      expect(resultNodes).toContainEqual(
        expect.objectContaining({
          sourceEventIds: [expect.any(String)],
          sourceTaskIds: [task.id],
          sourceResultIds: [result.id]
        })
      );
      expect(await store.reconstructLineState(branch.id)).toMatchObject({
        state: {
          latestResult: {
            id: result.id,
            summary: "Repeated buffer concatenation is the bottleneck."
          }
        }
      });

      const branchEventsBeforeMerge = await store.listEvents(branch.id);
      const mainlineEventsBeforeMerge = await store.listEvents(accepted.mainline.id);
      expect(mainlineEventsBeforeMerge).toHaveLength(1);
      expect(mainlineEventsBeforeMerge.some((event) => event.id === toolEvent.id)).toBe(false);

      const firstMerge = await store.publishBranchResult(branch.id, accepted.mainline.id, {
        resultId: result.id
      });
      const duplicateMerge = await store.mergeBranchResult(branch.id, accepted.mainline.id, {
        resultId: result.id
      });
      const mainlineEvents = await store.listEvents(accepted.mainline.id);
      const mergedResults = mainlineEvents.filter(
        (event) =>
          event.type === "branch_result" &&
          (event.payload as { readonly resultId?: string } | undefined)?.resultId === result.id
      );

      expect(duplicateMerge).toEqual(firstMerge);
      expect(mergedResults).toHaveLength(1);
      expect((await store.listEvents(branch.id)).length).toBeGreaterThan(branchEventsBeforeMerge.length);
      expect(await store.listEvents(branch.id)).toContainEqual(
        expect.objectContaining({ type: "branch_result_published" })
      );
      expect(await store.getBranch(branch.id)).toMatchObject({
        status: "active",
        mergedAt: expect.any(String)
      });
      await expect(
        store.createTask(branch.id, {
          executor: "repository-analyzer",
          input: { path: "src/parser.ts", focus: "validate the proposed fix" },
          idempotencyKey: "task-follow-up-after-publication"
        })
      ).resolves.toMatchObject({ status: "pending", branchId: branch.id });
      expect((await store.getBranchContext(branch.id)).events).toEqual(await store.listEvents(branch.id));
    });

    it("recovers unfinished work and traces a task to its branch source and session", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const branch = await store.createBranch({
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Background search",
        goal: "Collect references",
        reason: "Can run independently",
        createdBy: "user",
        idempotencyKey: "branch-request-2"
      });
      await store.transitionBranch(branch.id, {
        status: "active",
        idempotencyKey: "branch-active-2"
      });
      const task = await store.createTask(branch.id, {
        executor: "search",
        input: { query: "append-only event streams" },
        idempotencyKey: "task-request-2"
      });
      await store.transitionTask(task.id, {
        status: "running",
        idempotencyKey: "task-running-2"
      });

      const recovery = await store.getRecoveryState(accepted.session.id);
      const trace = await store.getTaskTrace(task.id);

      expect(recovery.activeBranches.map((item) => item.id)).toEqual([branch.id]);
      expect(recovery.unfinishedTasks.map((item) => item.id)).toEqual([task.id]);
      expect(trace).toMatchObject({
        task: { id: task.id },
        branch: { id: branch.id },
        mainline: { id: accepted.mainline.id },
        session: { id: accepted.session.id },
        branchSourceEvent: { id: accepted.lineEvent.id }
      });
    });

    it("requires referenced tasks before results and keeps branch lifecycle independent", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const branch = await store.createBranch({
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Guard task ownership",
        goal: "Keep unfinished work isolated",
        reason: "Exercise task lifecycle guards",
        createdBy: "agent",
        idempotencyKey: "branch-task-guards"
      });
      await store.transitionBranch(branch.id, {
        status: "active",
        idempotencyKey: "branch-task-guards-active"
      });
      const task = await store.createTask(branch.id, {
        executor: "repository-analyzer",
        input: { path: "packages/runtime-core" },
        idempotencyKey: "task-guards-create"
      });
      const eventsBeforeRejectedWrites = await store.listEvents(branch.id);

      await expect(
        store.createBranchResult(branch.id, {
          status: "completed",
          summary: "This result is premature.",
          sourceTaskIds: [task.id],
          idempotencyKey: "result-guards-premature"
        })
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
      await expect(
        store.transitionBranch(branch.id, {
          status: "completed",
          idempotencyKey: "branch-task-guards-premature-complete"
        })
      ).rejects.toMatchObject({ code: "invalid_state_transition" });
      await expect(
        store.appendEvent(accepted.mainline.id, {
          type: "tool_result",
          taskId: task.id,
          idempotencyKey: "mainline-task-event-rejected",
          payload: { output: "must stay on the branch" }
        })
      ).rejects.toMatchObject({ code: "ownership_mismatch" });

      expect(await store.listEvents(branch.id)).toEqual(eventsBeforeRejectedWrites);
      expect(await store.listEvents(accepted.mainline.id)).toEqual([accepted.lineEvent]);
      await expect(store.getBranch(branch.id)).resolves.toMatchObject({ status: "active" });
      await expect(store.getTask(task.id)).resolves.toMatchObject({ status: "pending" });

      await store.transitionTask(task.id, {
        status: "cancelled",
        idempotencyKey: "task-guards-cancel"
      });
      await expect(
        store.createBranchResult(branch.id, {
          status: "completed",
          summary: "All branch tasks are now terminal.",
          sourceTaskIds: [task.id],
          idempotencyKey: "result-guards-completed"
        })
      ).resolves.toMatchObject({ version: 1, status: "completed" });
      await expect(store.getBranch(branch.id)).resolves.toMatchObject({ status: "active" });
    });

    it("recovers and publishes each completed branch result independently", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const branch = await store.createBranch({
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Versioned result",
        goal: "Publish the newest result only",
        reason: "The branch refined its answer",
        createdBy: "agent",
        idempotencyKey: "branch-versioned-result"
      });
      const firstResult = await store.createBranchResult(branch.id, {
        id: "branch-result-version-1",
        version: 1,
        status: "completed",
        summary: "Initial result.",
        idempotencyKey: "result-version-1"
      });
      const latestResult = await store.createBranchResult(branch.id, {
        id: "branch-result-version-2",
        version: 2,
        status: "completed",
        summary: "Refined result.",
        idempotencyKey: "result-version-2"
      });

      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([firstResult, latestResult]);
      await expect(
        store.publishBranchResult(branch.id, accepted.mainline.id, {
          resultId: firstResult.id,
          idempotencyKey: "publish-first-result"
        })
      ).resolves.toMatchObject({ resultId: firstResult.id });
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([latestResult]);

      await expect(
        store.publishBranchResult(branch.id, accepted.mainline.id, {
          resultId: latestResult.id,
          idempotencyKey: "publish-latest-result"
        })
      ).resolves.toMatchObject({ resultId: latestResult.id });
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([]);
      expect(await store.getBranch(branch.id)).toMatchObject({ status: "created" });
      expect(await store.listNodes(branch.id, { kinds: ["task_result"] })).toHaveLength(2);
    });

    it("recovers an unmerged completed result after its branch is archived", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const branch = await store.createBranch({
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Archived result",
        goal: "Retain an unmerged result",
        reason: "The branch is no longer in active context",
        createdBy: "system",
        idempotencyKey: "branch-archived-result"
      });
      const result = await store.createBranchResult(branch.id, {
        status: "completed",
        summary: "Still pending merge.",
        idempotencyKey: "archived-result"
      });
      await store.transitionBranch(branch.id, {
        status: "archived",
        idempotencyKey: "archive-completed-branch"
      });

      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([result]);
      const merge = await store.mergeBranchResult(branch.id, accepted.mainline.id, {
        resultId: result.id,
        idempotencyKey: "merge-archived-result"
      });
      expect(await store.mergeBranchResult(branch.id, accepted.mainline.id, { resultId: result.id })).toEqual(merge);
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([]);
      expect(await store.getBranch(branch.id)).toMatchObject({
        status: "archived",
        mergedAt: expect.any(String)
      });
      expect(
        (await store.listEvents(accepted.mainline.id)).filter(
          (event) =>
            event.type === "branch_result" &&
            (event.payload as { readonly resultId?: string } | undefined)?.resultId === result.id
        )
      ).toHaveLength(1);
    });

    it("returns detached values so stored append-only payloads cannot be silently mutated", async () => {
      const { store } = harness;
      const accepted = await store.acceptNormalizedEvent(normalizedInput());
      const mutable = { nested: { value: "original" } };
      const event = await store.appendEvent(accepted.mainline.id, {
        type: "system_message",
        idempotencyKey: "immutable-event-1",
        payload: mutable
      });

      mutable.nested.value = "mutated by caller";
      (event.payload as { nested: { value: string } }).nested.value = "mutated return value";

      await expect(store.getEvent(event.id)).resolves.toMatchObject({
        payload: { nested: { value: "original" } }
      });
    });
  });
}

function normalizedInput(): AcceptNormalizedEventInput {
  return {
    sessionId: "qq:napcat:qq-local:private:user-1",
    platform: "qq",
    provider: "napcat",
    channelId: "qq-local",
    conversationType: "private",
    conversationId: "user-1",
    sourceEventId: "message-1",
    sourceMessageId: "message-1",
    sourceEventType: "message.created",
    senderId: "user-1",
    text: "Please analyze this separately.",
    message: {
      id: "message-1",
      type: "mixed",
      segments: [
        { type: "text", text: "Please analyze this separately." },
        { type: "image", fileId: "image-1" }
      ],
      raw: { message_type: "private" }
    },
    rawPayload: { post_type: "message", message_id: 1 },
    receivedAt: new Date(0).toISOString(),
    idempotencyKey: "qq\u001fqq-local\u001fmessage-1\u001fmessage.created",
    actorId: "user-1"
  };
}
