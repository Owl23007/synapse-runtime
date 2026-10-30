import { describe, expect, it } from "vitest";
import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import { withReplyContext } from "../../../src/runtime/message-utils.js";

function event(receivedAt: string): SynapseChannelEvent {
  return {
    id: "event-1",
    platform: "qq",
    channelId: "qq-official",
    eventType: "message.created",
    conversation: { id: "group-1", kind: "group" },
    sender: { id: "user-1" },
    message: { id: "message-1", type: "text", segments: [{ type: "text", text: "hello" }] },
    adapterCapabilities: { passiveReplyWindowSeconds: 300 },
    receivedAt
  };
}

describe("被动回复上下文", () => {
  it("仅在适配器窗口有效期间使用被动回复上下文", () => {
    const now = Date.parse("2026-07-29T12:05:00.000Z");
    const output = { type: "text" as const, segments: [{ type: "text" as const, text: "reply" }] };

    expect(withReplyContext(output, event("2026-07-29T12:00:01.000Z"), now)).toMatchObject({
      replyTo: { messageId: "message-1", eventId: "event-1" }
    });
    expect(withReplyContext(output, event("2026-07-29T12:00:00.000Z"), now).replyTo).toBeUndefined();
  });
});
