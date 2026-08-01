import { textMessage } from "@synapse/runtime-protocol";
import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../transcript/in-memory.js";
import { ContextComposer } from "./composer.js";

describe("ContextComposer structured context", () => {
  it("separates workspace, session, and turn context while retaining the legacy system prompt", async () => {
    const composer = new ContextComposer({
      transcriptStore: new InMemoryTranscriptStore(),
      structured: true,
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

    expect(context.system).toContain("Time context");
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
});
