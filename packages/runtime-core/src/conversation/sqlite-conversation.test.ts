import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MessageSegment, SynapseMessage } from "@synapse/runtime-protocol";
import { SqliteRuntimeContextStore } from "../index.js";

describe("SqliteRuntimeContextStore conversation model", () => {
  it("persists, isolates, traces, recovers, and idempotently merges a branched conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-conversation-sqlite-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const sessionId = "qq:napcat:qq-local:private:user-1";
    const receivedAt = "2026-07-26T08:00:00.000Z";
    const segments: readonly MessageSegment[] = [
      { type: "mention", target: "user", userId: "bot-1", label: "@Synapse" },
      { type: "text", text: " please investigate" },
      { type: "image", fileId: "image-1", alt: "a profiler screenshot" },
      { type: "reply", messageId: "previous-42", sequence: 42 }
    ];
    const message: SynapseMessage = {
      id: "platform-message-1",
      type: "mixed",
      segments,
      replyTo: { messageId: "previous-42", sequence: 42 },
      raw: {
        message: [
          { type: "at", data: { qq: "bot-1" } },
          { type: "text", data: { text: " please investigate" } }
        ]
      }
    };
    const rawPayload = {
      post_type: "message",
      message_type: "private",
      message_id: 9001,
      sender: { user_id: "user-1", nickname: "Alice" },
      extension: { futureField: ["preserved", { nested: true }] }
    };

    let store: SqliteRuntimeContextStore | undefined = new SqliteRuntimeContextStore({ databasePath });
    let mainlineId = "";
    let activeBranchId = "";
    let activeTaskId = "";
    let resultBranchId = "";
    let completedTaskId = "";
    let resultId = "";
    let toolEventId = "";
    let branchHistoryBeforeMerge: readonly string[] = [];

    try {
      const normalizedInput = {
        sessionId,
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "source-event-1",
        sourceMessageId: "platform-message-1",
        sourceEventType: "message.created",
        senderId: "user-1",
        text: "@Synapse please investigate",
        message,
        segments,
        triggerHint: {
          platformMentionedBot: true,
          selfUserId: "bot-1",
          replyTargetMessageId: "previous-42"
        },
        rawPayload,
        receivedAt,
        idempotencyKey: "normalized-request-1"
      } as const;

      const accepted = await store.acceptNormalizedEvent(normalizedInput);
      const acceptedAgain = await store.acceptNormalizedEvent(normalizedInput);
      mainlineId = accepted.mainline.id;

      expect(accepted.created).toBe(true);
      expect(acceptedAgain.created).toBe(false);
      expect(acceptedAgain.event).toEqual(accepted.event);
      expect(acceptedAgain.lineEvent).toEqual(accepted.lineEvent);
      expect(accepted.event).toMatchObject({
        sessionId,
        lineId: mainlineId,
        sourceEventId: "source-event-1",
        sourceMessageId: "platform-message-1",
        sourceEventType: "message.created",
        senderId: "user-1",
        text: "@Synapse please investigate",
        message,
        segments,
        rawPayload
      });
      expect(await store.listNormalizedEvents(sessionId)).toHaveLength(1);

      const lines = await store.listLines(sessionId);
      expect(lines.filter((line) => line.kind === "mainline")).toEqual([accepted.mainline]);
      expect(await store.listLines(sessionId, { kind: "mainline" })).toHaveLength(1);

      const activeBranchInput = {
        id: "branch-active",
        sessionId,
        parentMainlineId: mainlineId,
        sourceEventId: accepted.lineEvent.id,
        title: "Long-running investigation",
        goal: "Inspect the repository without blocking the mainline",
        reason: "background work",
        createdBy: "agent",
        idempotencyKey: "create-branch-active",
        contextSnapshot: { mainlineSummary: "The user requested a repository investigation." },
        createdAt: "2026-07-26T08:01:00.000Z"
      } as const;
      const activeBranch = await store.createBranch(activeBranchInput);
      expect(await store.createBranch(activeBranchInput)).toEqual(activeBranch);
      activeBranchId = activeBranch.id;
      const activeBranchTransitionInput = {
        status: "active",
        idempotencyKey: "activate-branch-active",
        createdAt: "2026-07-26T08:02:00.000Z"
      } as const;
      await store.transitionBranch(activeBranch.id, activeBranchTransitionInput);

      const activeTaskInput = {
        id: "task-active",
        executor: "repository-agent",
        workspaceId: "workspace-1",
        input: { operation: "scan", paths: ["packages/runtime-core"] },
        artifacts: [{ type: "log", id: "scan-log" }],
        idempotencyKey: "create-task-active",
        createdAt: "2026-07-26T08:03:00.000Z"
      } as const;
      const activeTask = await store.createTask(activeBranch.id, activeTaskInput);
      expect(await store.createTask(activeBranch.id, activeTaskInput)).toEqual(activeTask);
      activeTaskId = activeTask.id;
      const activeTaskTransitionInput = {
        status: "running",
        idempotencyKey: "run-task-active",
        createdAt: "2026-07-26T08:04:00.000Z"
      } as const;
      await store.transitionTask(activeTask.id, activeTaskTransitionInput);

      const resultBranchInput = {
        id: "branch-result",
        sessionId,
        parentMainlineId: mainlineId,
        sourceEventId: accepted.lineEvent.id,
        title: "Profiler analysis",
        goal: "Identify the parser bottleneck",
        reason: "tool-heavy analysis",
        createdBy: "agent",
        idempotencyKey: "create-branch-result",
        contextSnapshot: {
          mainlineSummary: "Investigate the supplied profiler screenshot.",
          referencedMessageId: accepted.lineEvent.id
        },
        createdAt: "2026-07-26T08:05:00.000Z"
      } as const;
      const resultBranch = await store.createBranch(resultBranchInput);
      expect(await store.createBranch(resultBranchInput)).toEqual(resultBranch);
      resultBranchId = resultBranch.id;
      await store.transitionBranch(resultBranch.id, {
        status: "active",
        idempotencyKey: "activate-branch-result",
        createdAt: "2026-07-26T08:06:00.000Z"
      });

      const completedTaskInput = {
        id: "task-completed",
        executor: "profiler-agent",
        workspaceId: "workspace-1",
        input: { operation: "profile", target: "body-parser" },
        idempotencyKey: "create-task-completed",
        createdAt: "2026-07-26T08:07:00.000Z"
      } as const;
      const completedTask = await store.createTask(resultBranch.id, completedTaskInput);
      expect(await store.createTask(resultBranch.id, completedTaskInput)).toEqual(completedTask);
      completedTaskId = completedTask.id;
      await store.transitionTask(completedTask.id, {
        status: "running",
        idempotencyKey: "run-task-completed",
        createdAt: "2026-07-26T08:08:00.000Z"
      });

      const toolEventInput = {
        id: "event-tool-call",
        type: "tool_call",
        idempotencyKey: "tool-call-profiler",
        taskId: completedTask.id,
        correlationId: resultBranch.id,
        payload: {
          tool: "profiler",
          arguments: { target: "body-parser" },
          rawRequest: { samples: [1, 2, 3] }
        },
        createdAt: "2026-07-26T08:09:00.000Z"
      } as const;
      const toolEvent = await store.appendEvent(resultBranch.id, toolEventInput);
      expect(await store.appendEvent(resultBranch.id, toolEventInput)).toEqual(toolEvent);
      toolEventId = toolEvent.id;

      const completedTaskTransitionInput = {
        status: "completed",
        output: {
          bottleneck: "repeated Buffer concatenation",
          measurements: { beforeMs: 12.4, expectedMs: 7.1 }
        },
        artifacts: [{ type: "profile", id: "profile-1", path: "artifacts/profile.json" }],
        idempotencyKey: "complete-task-completed",
        createdAt: "2026-07-26T08:10:00.000Z"
      } as const;
      await store.transitionTask(completedTask.id, completedTaskTransitionInput);

      const resultInput = {
        id: "result-1",
        version: 1,
        status: "completed",
        summary: "The main bottleneck is repeated Buffer concatenation.",
        artifacts: [{ type: "profile", id: "profile-1", path: "artifacts/profile.json" }],
        citations: [{ eventId: toolEvent.id, label: "Profiler output" }],
        nextActions: ["Use segmented Buffer reads", "Avoid intermediate strings"],
        sourceTaskIds: [completedTask.id],
        sourceEventId: toolEvent.id,
        idempotencyKey: "create-result-1",
        createdAt: "2026-07-26T08:11:00.000Z"
      } as const;
      const result = await store.createBranchResult(resultBranch.id, resultInput);
      expect(await store.createBranchResult(resultBranch.id, resultInput)).toEqual(result);
      resultId = result.id;
      expect(await store.listNodes(resultBranch.id, { kinds: ["task_result"] })).toContainEqual(
        expect.objectContaining({
          sourceTaskIds: [completedTask.id],
          sourceResultIds: [result.id]
        })
      );

      const mainlineBeforeMerge = await store.listEvents(mainlineId);
      expect(mainlineBeforeMerge.map((event) => event.type)).toEqual(["user_message"]);
      expect(mainlineBeforeMerge).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
      expect((await store.listEvents(resultBranch.id)).map((event) => event.id)).toContain(toolEvent.id);

      branchHistoryBeforeMerge = (await store.listEvents(resultBranch.id)).map((event) => event.id);
      store.close();
      store = undefined;

      store = new SqliteRuntimeContextStore({ databasePath });
      const restoredNormalized = await store.getNormalizedEvent(accepted.event.id);
      expect(restoredNormalized).toEqual(accepted.event);
      expect(restoredNormalized?.message).toEqual(message);
      expect(restoredNormalized?.segments).toEqual(segments);
      expect(restoredNormalized?.rawPayload).toEqual(rawPayload);

      expect((await store.acceptNormalizedEvent(normalizedInput)).created).toBe(false);
      expect((await store.createBranch(activeBranchInput)).id).toBe(activeBranchId);
      expect((await store.transitionBranch(activeBranchId, activeBranchTransitionInput)).status).toBe("active");
      expect((await store.createTask(activeBranchId, activeTaskInput)).id).toBe(activeTaskId);
      expect((await store.transitionTask(activeTaskId, activeTaskTransitionInput)).status).toBe("running");
      expect((await store.createBranch(resultBranchInput)).id).toBe(resultBranchId);
      expect((await store.createTask(resultBranchId, completedTaskInput)).id).toBe(completedTaskId);
      expect((await store.transitionTask(completedTaskId, completedTaskTransitionInput)).status).toBe("completed");
      expect(await store.createBranchResult(resultBranchId, resultInput)).toEqual(result);
      expect((await store.listEvents(resultBranchId)).map((event) => event.id)).toEqual(branchHistoryBeforeMerge);
      expect(await store.reconstructLineState(resultBranchId)).toMatchObject({
        state: {
          latestResult: {
            id: result.id,
            summary: "The main bottleneck is repeated Buffer concatenation."
          }
        }
      });

      const recovery = await store.getRecoveryState(sessionId);
      expect(recovery.activeBranches.map((branch) => branch.id)).toContain(activeBranchId);
      expect(recovery.unfinishedTasks).toContainEqual(
        expect.objectContaining({ id: activeTaskId, branchId: activeBranchId, status: "running" })
      );
      expect(recovery.unmergedResults).toContainEqual(
        expect.objectContaining({ id: resultId, branchId: resultBranchId, version: 1 })
      );

      const taskTrace = await store.getTaskTrace(completedTaskId);
      expect(taskTrace).toMatchObject({
        task: { id: completedTaskId, branchId: resultBranchId, status: "completed" },
        branch: { id: resultBranchId, sourceEventId: accepted.lineEvent.id },
        mainline: { id: mainlineId, sessionId },
        session: { id: sessionId },
        branchSourceEvent: { id: accepted.lineEvent.id }
      });
      expect(taskTrace.events.map((event) => event.id)).toContain(toolEventId);
      expect(taskTrace.results.map((branchResult) => branchResult.id)).toEqual([resultId]);

      const branchContextBeforeMerge = await store.getBranchContext(resultBranchId);
      expect(branchContextBeforeMerge.sourceEvent.id).toBe(accepted.lineEvent.id);
      expect(branchContextBeforeMerge.events.map((event) => event.id)).toEqual(branchHistoryBeforeMerge);
      expect(branchContextBeforeMerge.tasks.map((task) => task.id)).toEqual([completedTaskId]);
      expect(branchContextBeforeMerge.results.map((branchResult) => branchResult.id)).toEqual([resultId]);

      const mergeInput = {
        id: "merge-1",
        resultId,
        eventId: "event-mainline-result-1",
        branchEventId: "event-branch-merged-1",
        idempotencyKey: "merge-result-1",
        createdAt: "2026-07-26T08:12:00.000Z"
      } as const;
      const merge = await store.mergeBranchResult(resultBranchId, mainlineId, mergeInput);
      expect(await store.mergeBranchResult(resultBranchId, mainlineId, mergeInput)).toEqual(merge);

      const mainlineAfterMerge = await store.listEvents(mainlineId);
      expect(mainlineAfterMerge.filter((event) => event.type === "branch_result")).toEqual([
        expect.objectContaining({
          id: merge.mainlineEventId,
          lineId: mainlineId,
          payload: expect.objectContaining({
            resultId,
            branchId: resultBranchId,
            summary: "The main bottleneck is repeated Buffer concatenation."
          })
        })
      ]);
      expect(mainlineAfterMerge).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
      expect((await store.listEvents(resultBranchId)).map((event) => event.id)).toEqual([
        ...branchHistoryBeforeMerge,
        merge.branchEventId
      ]);

      store.close();
      store = undefined;
      store = new SqliteRuntimeContextStore({ databasePath });

      expect(await store.mergeBranchResult(resultBranchId, mainlineId, mergeInput)).toEqual(merge);
      expect((await store.listEvents(mainlineId)).filter((event) => event.type === "branch_result")).toHaveLength(1);
      const restoredBranchHistory = await store.listEvents(resultBranchId);
      expect(restoredBranchHistory.map((event) => event.id)).toEqual([
        ...branchHistoryBeforeMerge,
        "event-branch-merged-1"
      ]);
      expect(restoredBranchHistory).toContainEqual(
        expect.objectContaining({
          id: toolEventId,
          type: "tool_call",
          taskId: completedTaskId
        })
      );
      expect(
        (await store.getRecoveryState(sessionId)).unmergedResults.map((branchResult) => branchResult.id)
      ).not.toContain(resultId);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts distinct messages in one session despite changing conversation metadata and deduplicates replays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-conversation-sqlite-messages-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const store = new SqliteRuntimeContextStore({ databasePath });
    const sessionId = "qq:napcat:qq-local:group:group-1";

    try {
      const firstInput = {
        sessionId,
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "group",
        conversationId: "group-1",
        sourceEventId: "group-message-1",
        sourceMessageId: "group-message-1",
        sourceEventType: "message.created",
        senderId: "user-1",
        text: "First message",
        receivedAt: "2026-07-26T09:00:00.000Z",
        idempotencyKey: "normalized-group-message-1",
        sessionMetadata: { conversationTitle: "Original group title" }
      } as const;
      const secondInput = {
        ...firstInput,
        sourceEventId: "group-message-2",
        sourceMessageId: "group-message-2",
        senderId: "user-2",
        text: "Second message",
        receivedAt: "2026-07-26T09:01:00.000Z",
        idempotencyKey: "normalized-group-message-2",
        sessionMetadata: { conversationTitle: "Renamed group title" }
      } as const;

      const first = await store.acceptNormalizedEvent(firstInput);
      const second = await store.acceptNormalizedEvent(secondInput);
      const replayedSecond = await store.acceptNormalizedEvent(secondInput);
      await expect(
        store.acceptNormalizedEvent({
          ...firstInput,
          sessionId: "qq:napcat:qq-local:group:group-2",
          conversationId: "group-2",
          idempotencyKey: "replayed-under-another-conversation"
        })
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const correction = await store.acceptNormalizedEvent({
        ...firstInput,
        sourceEventType: "message.deleted",
        lineEventType: "correction",
        text: "",
        idempotencyKey: "normalized-group-message-1-deleted"
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(replayedSecond.created).toBe(false);
      expect(correction.created).toBe(true);
      expect(replayedSecond.event).toEqual(second.event);
      expect(replayedSecond.lineEvent).toEqual(second.lineEvent);
      expect(second.session.id).toBe(first.session.id);
      expect(second.mainline.id).toBe(first.mainline.id);
      expect(second.session.metadata).toEqual({ conversationTitle: "Original group title" });
      expect((await store.listNormalizedEvents(sessionId)).map((event) => event.id)).toEqual([
        first.event.id,
        correction.event.id,
        second.event.id
      ]);
      expect((await store.listEvents(first.mainline.id)).map((event) => event.id)).toEqual([
        first.lineEvent.id,
        second.lineEvent.id,
        correction.lineEvent.id
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers and publishes each SQLite branch result version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-core-conversation-sqlite-results-"));
    const databasePath = join(dir, "runtime-context.sqlite");
    const store = new SqliteRuntimeContextStore({ databasePath });

    try {
      const accepted = await store.acceptNormalizedEvent({
        sessionId: "qq:napcat:qq-local:private:version-user",
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "version-user",
        sourceEventId: "version-message-1",
        sourceMessageId: "version-message-1",
        sourceEventType: "message.created",
        senderId: "version-user",
        text: "Refine this result.",
        receivedAt: "2026-07-26T10:00:00.000Z",
        idempotencyKey: "normalized-version-message-1"
      });
      const branch = await store.createBranch({
        id: "sqlite-version-branch",
        sessionId: accepted.session.id,
        parentMainlineId: accepted.mainline.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Versioned SQLite result",
        goal: "Return only the latest refinement",
        reason: "The first result was superseded",
        createdBy: "agent",
        idempotencyKey: "create-sqlite-version-branch",
        createdAt: "2026-07-26T10:01:00.000Z"
      });
      const firstResult = await store.createBranchResult(branch.id, {
        id: "sqlite-result-version-1",
        version: 1,
        status: "completed",
        summary: "Initial SQLite result.",
        idempotencyKey: "create-sqlite-result-version-1",
        createdAt: "2026-07-26T10:02:00.000Z"
      });
      const latestResult = await store.createBranchResult(branch.id, {
        id: "sqlite-result-version-2",
        version: 2,
        status: "completed",
        summary: "Refined SQLite result.",
        idempotencyKey: "create-sqlite-result-version-2",
        createdAt: "2026-07-26T10:03:00.000Z"
      });

      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([firstResult, latestResult]);
      await expect(
        store.publishBranchResult(branch.id, accepted.mainline.id, {
          resultId: firstResult.id,
          idempotencyKey: "publish-first-sqlite-result"
        })
      ).resolves.toMatchObject({ resultId: firstResult.id });
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([latestResult]);

      await expect(
        store.publishBranchResult(branch.id, accepted.mainline.id, {
          resultId: latestResult.id,
          idempotencyKey: "publish-latest-sqlite-result"
        })
      ).resolves.toMatchObject({ resultId: latestResult.id });
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([]);
      expect(await store.getBranch(branch.id)).toMatchObject({ status: "created" });
      await expect(
        store.createTask(branch.id, {
          executor: "sub-agent",
          input: { goal: "Follow up on the published refinements" },
          idempotencyKey: "create-sqlite-follow-up-task"
        })
      ).resolves.toMatchObject({ status: "pending", branchId: branch.id });
      expect(await store.listNodes(branch.id, { kinds: ["task_result"] })).toHaveLength(2);

      const archivedBranch = await store.createBranch({
        id: "sqlite-archived-result-branch",
        sessionId: accepted.session.id,
        parentMainlineId: accepted.mainline.id,
        sourceEventId: accepted.lineEvent.id,
        title: "Archived result",
        goal: "Retain an unmerged result",
        reason: "The branch is no longer in active context",
        createdBy: "system",
        idempotencyKey: "create-sqlite-archived-result-branch",
        createdAt: "2026-07-26T10:04:00.000Z"
      });
      const archivedResult = await store.createBranchResult(archivedBranch.id, {
        status: "completed",
        summary: "Still pending merge.",
        idempotencyKey: "create-sqlite-archived-result",
        createdAt: "2026-07-26T10:05:00.000Z"
      });
      await store.transitionBranch(archivedBranch.id, {
        status: "archived",
        idempotencyKey: "archive-sqlite-completed-branch",
        createdAt: "2026-07-26T10:06:00.000Z"
      });

      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([archivedResult]);
      const archivedMerge = await store.mergeBranchResult(archivedBranch.id, accepted.mainline.id, {
        resultId: archivedResult.id,
        idempotencyKey: "merge-sqlite-archived-result",
        createdAt: "2026-07-26T10:07:00.000Z"
      });
      expect(
        await store.mergeBranchResult(archivedBranch.id, accepted.mainline.id, {
          resultId: archivedResult.id
        })
      ).toEqual(archivedMerge);
      expect((await store.getRecoveryState(accepted.session.id)).unmergedResults).toEqual([]);
      expect(await store.getBranch(archivedBranch.id)).toMatchObject({
        status: "archived",
        mergedAt: "2026-07-26T10:07:00.000Z"
      });
      expect(
        (await store.listEvents(accepted.mainline.id)).filter(
          (event) =>
            event.type === "branch_result" &&
            (event.payload as { readonly resultId?: string } | undefined)?.resultId === archivedResult.id
        )
      ).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
