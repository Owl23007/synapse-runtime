import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import { InMemoryConversationStore } from "./in-memory.js";
import type { ConversationStore } from "./types.js";

describe.each([
  {
    name: "in-memory",
    create: (): { readonly store: ConversationStore; readonly close: () => void } => ({
      store: new InMemoryConversationStore(),
      close: () => undefined
    })
  },
  {
    name: "sqlite",
    create: (): { readonly store: ConversationStore; readonly close: () => void } => {
      const directory = mkdtempSync(join(tmpdir(), "synapse-context-graph-"));
      const sqlite = new SqliteRuntimeContextStore({
        databasePath: join(directory, "runtime-context.sqlite")
      });
      return {
        store: sqlite,
        close: () => {
          sqlite.close();
          rmSync(directory, { recursive: true, force: true });
        }
      };
    }
  }
])("conversation context graph using $name storage", ({ create }) => {
  it("rebuilds a forked branch from immutable nodes and the nearest snapshot", async () => {
    const { store, close } = create();
    try {
      const accepted = await store.acceptNormalizedEvent({
        sessionId: "session-context-graph",
        platform: "cli",
        provider: "local",
        channelId: "terminal",
        conversationType: "cli",
        conversationId: "context-graph",
        sourceEventId: "message-context-graph",
        sourceEventType: "message.created",
        senderId: "user-1",
        text: "设计上下文图",
        receivedAt: "2026-07-27T10:00:00.000Z",
        idempotencyKey: "accept-context-graph"
      });
      const mainlineNode = await store.createNode(accepted.mainline.id, {
        id: "node-mainline-context",
        kind: "decision",
        title: "上下文优先于任务",
        statePatch: {
          principles: {
            attributionBeforeExecution: true
          }
        },
        sourceEventIds: [accepted.lineEvent.id],
        createdBy: "agent",
        idempotencyKey: "node-mainline-context",
        createdAt: "2026-07-27T10:01:00.000Z"
      });
      const branch = await store.createBranch({
        id: "branch-context-graph",
        sessionId: accepted.session.id,
        sourceEventId: accepted.lineEvent.id,
        title: "上下文图设计",
        goal: "形成可恢复的语义脉络",
        reason: "该主题需要独立演化",
        createdBy: "agent",
        idempotencyKey: "create-branch-context-graph",
        createdAt: "2026-07-27T10:02:00.000Z"
      });
      const forkNodeInput = {
        id: "node-branch-fork",
        parentIds: [mainlineNode.id],
        kind: "fork",
        title: "分叉上下文图设计",
        statePatch: {
          currentFocus: "语义节点和状态重建",
          openQuestions: ["如何恢复分支状态"]
        },
        sourceEventIds: [accepted.lineEvent.id],
        createdBy: "agent",
        idempotencyKey: "node-branch-fork",
        createdAt: "2026-07-27T10:03:00.000Z"
      } as const;
      const forkNode = await store.createNode(branch.id, forkNodeInput);
      expect(await store.createNode(branch.id, forkNodeInput)).toEqual(forkNode);

      const decisionNode = await store.createNode(branch.id, {
        id: "node-branch-decision",
        kind: "decision",
        title: "使用快照和增量节点恢复状态",
        statePatch: {
          decisions: ["完整事实持久化", "执行上下文临时重建"]
        },
        sourceEventIds: [accepted.lineEvent.id],
        createdBy: "agent",
        idempotencyKey: "node-branch-decision",
        createdAt: "2026-07-27T10:04:00.000Z"
      });

      expect(await store.getLineHead(branch.id)).toEqual({
        lineId: branch.id,
        nodeId: decisionNode.id,
        updatedAt: decisionNode.createdAt
      });
      expect(await store.reconstructLineState(branch.id)).toMatchObject({
        headNodeId: decisionNode.id,
        state: {
          principles: {
            attributionBeforeExecution: true
          },
          currentFocus: "语义节点和状态重建",
          openQuestions: ["如何恢复分支状态"],
          decisions: ["完整事实持久化", "执行上下文临时重建"]
        },
        appliedNodeIds: [mainlineNode.id, forkNode.id, decisionNode.id]
      });

      const snapshot = await store.createContextSnapshot(branch.id, {
        id: "snapshot-branch-context",
        idempotencyKey: "snapshot-branch-context",
        createdAt: "2026-07-27T10:05:00.000Z"
      });
      const resolvedNode = await store.createNode(branch.id, {
        id: "node-question-resolved",
        kind: "question_resolved",
        title: "确认上下文可按节点重建",
        statePatch: {
          openQuestions: null,
          reconstruction: {
            mode: "snapshot-and-nodes"
          }
        },
        createdBy: "agent",
        idempotencyKey: "node-question-resolved",
        createdAt: "2026-07-27T10:06:00.000Z"
      });
      const reconstructed = await store.reconstructLineState(branch.id);

      expect(snapshot.nodeId).toBe(decisionNode.id);
      expect(reconstructed.snapshot?.id).toBe(snapshot.id);
      expect(reconstructed.appliedNodeIds).toEqual([resolvedNode.id]);
      expect(reconstructed.state).toEqual({
        principles: {
          attributionBeforeExecution: true
        },
        currentFocus: "语义节点和状态重建",
        decisions: ["完整事实持久化", "执行上下文临时重建"],
        reconstruction: {
          mode: "snapshot-and-nodes"
        }
      });
      expect((await store.listNodes(branch.id)).map((node) => node.id)).toEqual([
        forkNode.id,
        decisionNode.id,
        resolvedNode.id
      ]);
    } finally {
      close();
    }
  });
});

describe("SQLite context graph recovery", () => {
  it("restores line heads and reconstructs state after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-context-graph-recovery-"));
    const databasePath = join(directory, "runtime-context.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath });
    try {
      const accepted = await store.acceptNormalizedEvent({
        sessionId: "session-context-recovery",
        platform: "cli",
        provider: "local",
        channelId: "terminal",
        conversationType: "cli",
        conversationId: "context-recovery",
        sourceEventId: "message-context-recovery",
        sourceEventType: "message.created",
        senderId: "user-1",
        text: "恢复上下文",
        receivedAt: "2026-07-27T11:00:00.000Z",
        idempotencyKey: "accept-context-recovery"
      });
      const node = await store.createNode(accepted.mainline.id, {
        id: "node-context-recovery",
        kind: "decision",
        title: "持久化节点来源而非完整提示词",
        statePatch: {
          persistence: "manifest-only"
        },
        createdBy: "agent",
        idempotencyKey: "node-context-recovery",
        createdAt: "2026-07-27T11:01:00.000Z"
      });
      await store.createContextSnapshot(accepted.mainline.id, {
        id: "snapshot-context-recovery",
        idempotencyKey: "snapshot-context-recovery",
        createdAt: "2026-07-27T11:02:00.000Z"
      });

      store.close();
      store = new SqliteRuntimeContextStore({ databasePath });

      expect(await store.getLineHead(accepted.mainline.id)).toMatchObject({ nodeId: node.id });
      expect(await store.getLatestContextSnapshot(accepted.mainline.id)).toMatchObject({
        nodeId: node.id,
        state: {
          persistence: "manifest-only"
        }
      });
      expect(await store.reconstructLineState(accepted.mainline.id)).toMatchObject({
        headNodeId: node.id,
        state: {
          persistence: "manifest-only"
        },
        appliedNodeIds: []
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
