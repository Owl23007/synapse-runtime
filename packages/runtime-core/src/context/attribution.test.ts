import { describe, expect, it } from "vitest";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { InMemoryConversationStore } from "../conversation/in-memory.js";
import { InMemoryTranscriptStore } from "../transcript/in-memory.js";
import { ContextAttributorLite, classifyInteractionNature } from "./attribution.js";

describe("ContextAttributorLite", () => {
  it("keeps short natural follow-ups on the current branch", async () => {
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const accepted = await conversationStore.acceptNormalizedEvent({
      sessionId: "session-attribution",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "attribution",
      sourceEventId: "message-root",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "设计上下文路由",
      receivedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "accept-root"
    });
    const branch = await conversationStore.createBranch({
      id: "branch-attribution",
      sessionId: accepted.session.id,
      sourceEventId: accepted.lineEvent.id,
      title: "上下文归属设计",
      goal: "判断消息属于哪条语义脉络",
      reason: "需要独立恢复和继续讨论",
      createdBy: "agent",
      idempotencyKey: "create-branch-attribution",
      createdAt: "2026-07-27T12:01:00.000Z"
    });
    await conversationStore.acceptNormalizedEvent({
      sessionId: accepted.session.id,
      targetLineId: branch.id,
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "attribution",
      sourceEventId: "message-branch",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "先用强关联规则",
      receivedAt: "2026-07-27T12:02:00.000Z",
      idempotencyKey: "accept-branch"
    });
    const attributor = new ContextAttributorLite({
      conversationStore,
      transcriptStore
    });

    await expect(
      attributor.attribute({
        event: channelEvent("message-followup", "那语义相近时怎么办", "2026-07-27T12:03:00.000Z"),
        provider: "local",
        sessionId: accepted.session.id
      })
    ).resolves.toMatchObject({
      nature: "conversation_continue",
      action: "continue",
      targetLineId: branch.id,
      confidence: 0.78,
      reasons: ["recent_branch_continuity"]
    });
  });

  it("uses reply provenance before semantic similarity and preserves replay attribution", async () => {
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const accepted = await conversationStore.acceptNormalizedEvent({
      sessionId: "session-reply-attribution",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "reply-attribution",
      sourceEventId: "message-root",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "开始",
      receivedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "accept-reply-root"
    });
    const branch = await conversationStore.createBranch({
      id: "branch-reply-attribution",
      sessionId: accepted.session.id,
      sourceEventId: accepted.lineEvent.id,
      title: "Agent Loop",
      goal: "设计工具执行循环",
      reason: "独立语义脉络",
      createdBy: "agent",
      idempotencyKey: "create-branch-reply-attribution",
      createdAt: "2026-07-27T12:01:00.000Z"
    });
    await transcriptStore.append({
      sessionId: accepted.session.id,
      lineId: branch.id,
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "reply-attribution",
      role: "assistant",
      text: "阶段结果",
      externalMessageId: "assistant-42",
      createdAt: "2026-07-27T12:02:00.000Z"
    });
    const attributor = new ContextAttributorLite({
      conversationStore,
      transcriptStore
    });
    const replyEvent = {
      ...channelEvent("message-reply", "这个结论需要调整", "2026-07-28T12:00:00.000Z"),
      conversation: {
        id: "reply-attribution",
        kind: "private"
      },
      message: {
        ...textMessage("这个结论需要调整", "message-reply"),
        replyTo: {
          messageId: "assistant-42"
        }
      }
    } satisfies SynapseChannelEvent;

    await expect(
      attributor.attribute({
        event: replyEvent,
        provider: "local",
        sessionId: accepted.session.id
      })
    ).resolves.toMatchObject({
      nature: "correction",
      action: "resume",
      targetLineId: branch.id,
      confidence: 0.99,
      reasons: ["reply_relation"]
    });

    await conversationStore.acceptNormalizedEvent({
      sessionId: accepted.session.id,
      targetLineId: branch.id,
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "reply-attribution",
      sourceEventId: "message-reply",
      sourceMessageId: "message-reply",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "这个结论需要调整",
      message: replyEvent.message,
      receivedAt: replyEvent.receivedAt,
      idempotencyKey: "accept-message-reply"
    });
    await expect(
      attributor.attribute({
        event: replyEvent,
        provider: "local",
        sessionId: accepted.session.id
      })
    ).resolves.toMatchObject({
      targetLineId: branch.id,
      confidence: 1,
      reasons: ["normalized_event_replay"]
    });
  });

  it("falls back to the mainline when a topic shift has no unambiguous branch", async () => {
    const conversationStore = new InMemoryConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const accepted = await conversationStore.acceptNormalizedEvent({
      sessionId: "session-topic-shift",
      platform: "cli",
      provider: "local",
      channelId: "terminal",
      conversationType: "private",
      conversationId: "topic-shift",
      sourceEventId: "message-root",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "讨论 Runtime",
      receivedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "accept-topic-root"
    });
    await conversationStore.createBranch({
      id: "branch-runtime-context",
      sessionId: accepted.session.id,
      sourceEventId: accepted.lineEvent.id,
      title: "Runtime 上下文图",
      goal: "设计语义节点",
      reason: "上下文恢复",
      createdBy: "agent",
      idempotencyKey: "create-branch-runtime-context"
    });
    const attributor = new ContextAttributorLite({
      conversationStore,
      transcriptStore
    });

    await expect(
      attributor.attribute({
        event: channelEvent("message-topic-shift", "换个话题聊晚饭", "2026-07-27T12:01:00.000Z"),
        provider: "local",
        sessionId: accepted.session.id
      })
    ).resolves.toMatchObject({
      nature: "topic_shift",
      action: "mainline",
      reasons: ["semantic_match_below_threshold"]
    });
  });
});

describe("classifyInteractionNature", () => {
  it("distinguishes commands corrections and task requests", () => {
    expect(classifyInteractionNature("/branch 上下文图")).toBe("command");
    expect(classifyInteractionNature("不是这样，需要修正")).toBe("correction");
    expect(classifyInteractionNature("检查一下当前仓库")).toBe("task_request");
  });
});

function channelEvent(id: string, text: string, receivedAt: string): SynapseChannelEvent {
  return {
    id,
    platform: "cli",
    channelId: "terminal",
    eventType: "message.created",
    conversation: {
      id: "attribution",
      kind: "private"
    },
    sender: {
      id: "user-1"
    },
    message: textMessage(text, id),
    receivedAt
  };
}
