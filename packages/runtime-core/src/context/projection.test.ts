import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../conversation/in-memory.js";
import { InMemoryTranscriptStore } from "../transcript/in-memory.js";
import { BranchContextProjector } from "./projection.js";

describe("BranchContextProjector", () => {
  it("reconstructs a compact branch view from semantic state and selected facts", async () => {
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const accepted = await conversationStore.acceptNormalizedEvent({
      sessionId: "session-projection",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "cli",
      conversationId: "projection",
      sourceEventId: "source-projection",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "设计上下文恢复",
      receivedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "accept-projection"
    });
    const branch = await conversationStore.createBranch({
      id: "branch-projection",
      sessionId: accepted.session.id,
      sourceEventId: accepted.lineEvent.id,
      title: "上下文恢复设计",
      goal: "不持久化完整提示词也能恢复分支",
      reason: "该语义脉络需要独立演化",
      createdBy: "agent",
      idempotencyKey: "create-branch-projection",
      createdAt: "2026-07-27T12:01:00.000Z"
    });
    const evidence = await conversationStore.appendEvent(branch.id, {
      id: "event-projection-evidence",
      type: "tool_result",
      idempotencyKey: "event-projection-evidence",
      payload: {
        summary: "上下文恢复应使用来源清单和语义节点"
      },
      createdAt: "2026-07-27T12:02:00.000Z"
    });
    const node = await conversationStore.createNode(branch.id, {
      id: "node-projection-decision",
      kind: "decision",
      title: "执行上下文采用临时投影",
      statePatch: {
        currentFocus: "根据语义节点重建上下文",
        decisions: ["完整事实持久化", "完整提示词不持久化"],
        openQuestions: ["相近分支如何消歧"]
      },
      sourceEventIds: [evidence.id],
      createdBy: "agent",
      idempotencyKey: "node-projection-decision",
      createdAt: "2026-07-27T12:03:00.000Z"
    });
    const message = await transcriptStore.append({
      sessionId: accepted.session.id,
      lineId: branch.id,
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "cli",
      conversationId: "projection",
      role: "user",
      actorId: "user-1",
      text: "继续讨论上下文恢复",
      idempotencyKey: "transcript-projection",
      createdAt: "2026-07-27T12:04:00.000Z"
    });
    const task = await conversationStore.createTask(branch.id, {
      id: "task-projection",
      executor: "sub-agent",
      input: {
        goal: "验证上下文恢复设计"
      },
      idempotencyKey: "task-projection",
      createdAt: "2026-07-27T12:05:00.000Z"
    });

    const projection = await new BranchContextProjector({
      conversationStore,
      transcriptStore
    }).project({
      branchId: branch.id,
      currentInput: "上下文恢复需要哪些来源",
      maxChars: 4000
    });
    const value = JSON.parse(projection.contextText) as {
      readonly identity: { readonly title: string };
      readonly semantic: {
        readonly headNodeId: string;
        readonly state: { readonly currentFocus: string };
      };
      readonly recentMessages: readonly { readonly text: string }[];
      readonly retrievedEvidence: readonly { readonly id: string }[];
    };

    expect(value.identity.title).toBe("上下文恢复设计");
    expect(value.semantic.headNodeId).toBe(node.id);
    expect(value.semantic.state.currentFocus).toBe("根据语义节点重建上下文");
    expect(value.recentMessages).toContainEqual(expect.objectContaining({ text: "继续讨论上下文恢复" }));
    expect(value.retrievedEvidence).toContainEqual(expect.objectContaining({ id: evidence.id }));
    expect(projection.manifest).toMatchObject({
      branchHeadNodeId: node.id,
      semanticNodeIds: [node.id],
      recentMessageIds: [message.id],
      taskIds: [task.id]
    });
    expect(projection.manifest.retrievedEventIds).toContain(evidence.id);
    expect(projection.budget).toEqual({
      maxChars: 4000,
      usedChars: projection.contextText.length,
      truncated: false
    });
  });

  it("enforces the projection character budget without persisting the generated view", async () => {
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const accepted = await conversationStore.acceptNormalizedEvent({
      sessionId: "session-projection-budget",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "cli",
      conversationId: "projection-budget",
      sourceEventId: "source-projection-budget",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "创建预算测试",
      receivedAt: "2026-07-27T13:00:00.000Z",
      idempotencyKey: "accept-projection-budget"
    });
    const branch = await conversationStore.createBranch({
      sessionId: accepted.session.id,
      sourceEventId: accepted.lineEvent.id,
      title: "上下文预算",
      goal: "验证投影裁剪",
      reason: "避免完整历史进入提示词",
      createdBy: "agent",
      idempotencyKey: "create-branch-projection-budget"
    });

    const projection = await new BranchContextProjector({
      conversationStore,
      transcriptStore
    }).project({
      branchId: branch.id,
      currentInput: "继续",
      maxChars: 120
    });

    expect(projection.contextText.length).toBeLessThanOrEqual(120);
    expect(projection.contextText).toContain("已按预算截断");
    expect(projection.budget.truncated).toBe(true);
  });
});
