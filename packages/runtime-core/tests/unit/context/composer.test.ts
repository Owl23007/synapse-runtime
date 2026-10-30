import { textMessage } from "@synapse/runtime-protocol";
import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../../../src/transcript/in-memory.js";
import { InMemoryMemoryStore } from "../../../src/memory/in-memory.js";
import { ContextComposer } from "../../../src/context/composer.js";

describe("结构化上下文组合", () => {
  it("分离工作区、会话与轮次上下文且不回退到平铺系统提示词", async () => {
    const composer = new ContextComposer({
      transcriptStore: new InMemoryTranscriptStore(),
      strategy: "chat.zh-CN",
      timezone: "Asia/Shanghai"
    });
    const context = await composer.compose({
      event: {
        id: "event-1",
        platform: "qq",
        channelId: "qq-local",
        eventType: "message.created",
        conversation: { id: "user-1", kind: "private" },
        sender: { id: "user-1" },
        message: textMessage("现在几点？"),
        receivedAt: "2026-08-01T12:00:00.000Z"
      },
      actor: {
        identity: { id: "user-1", type: "owner", trustLevel: "owner", roles: [] },
        platformIdentity: {
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          platformUserId: "user-1"
        },
        isBound: true
      },
      workspace: { id: "personal:user-1", type: "personal", name: "个人空间" },
      outputPolicy: {
        mode: "normal",
        maxChars: 4000,
        allowMarkdown: true,
        allowCodeBlock: true,
        appendExpandHint: false
      },
      sessionId: "qq:user-1",
      currentInput: textMessage("现在几点？"),
      includeHistory: false,
      maxMessages: 20
    });

    expect(context).not.toHaveProperty("system");
    expect(context.metadata.contextStrategy).toBe("chat.zh-CN");
    expect(context.sections?.map((section) => section.id)).toEqual(["workspace", "turn"]);
    expect(context.sections?.[0]?.blocks[0]).toMatchObject({
      id: "workspace-and-output",
      stability: "workspace",
      cache: { scope: "workspace" }
    });
    expect(context.sections?.[1]?.blocks[0]).toMatchObject({
      id: "time",
      stability: "turn",
      cache: { scope: "none" }
    });
  });

  it("按 maxHistoryChars 限制长期记忆上下文并保留截断标记", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.remember({
      scopeType: "identity",
      scopeId: "user-1",
      identityId: "user-1",
      visibility: "private",
      content: "这是一段需要被上下文预算截断的长期偏好".repeat(10),
      source: "test",
      idempotencyKey: "memory-budget-1"
    });
    const composer = new ContextComposer({
      transcriptStore: new InMemoryTranscriptStore(),
      memoryStore,
      maxHistoryChars: 140
    });
    const context = await composer.compose({
      event: {
        id: "event-memory-budget",
        platform: "qq",
        channelId: "qq-local",
        eventType: "message.created",
        conversation: { id: "user-1", kind: "private" },
        sender: { id: "user-1" },
        message: textMessage("hello"),
        receivedAt: "2026-08-01T12:00:00.000Z"
      },
      actor: {
        identity: { id: "user-1", type: "guest", trustLevel: "guest", roles: [] },
        platformIdentity: {
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          platformUserId: "user-1"
        },
        isBound: false
      },
      workspace: { id: "personal:user-1", type: "personal", name: "个人空间" },
      outputPolicy: {
        mode: "normal",
        maxChars: 4000,
        allowMarkdown: true,
        allowCodeBlock: true,
        appendExpandHint: false
      },
      sessionId: "session-memory-budget",
      currentInput: textMessage("hello"),
      includeHistory: false,
      maxMessages: 20
    });
    const memoryBlock = context.sections.find((section) => section.id === "memory")?.blocks[0];
    expect(memoryBlock?.content.length).toBeLessThanOrEqual(140);
    expect(memoryBlock?.content).toContain("truncated");
  });
});
