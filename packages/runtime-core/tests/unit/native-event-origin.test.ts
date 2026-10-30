import { describe, expect, it } from "vitest";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";

describe("原生事件来源与会话触发分离", () => {
  const router = new ConversationRouter({ privateTrigger: { mode: "always" }, groupTrigger: { mode: "always" } });
  const event: SynapseChannelEvent = {
    id: "m",
    platform: "native",
    channelId: "native",
    eventType: "message.created",
    conversation: { id: "u", kind: "private" },
    sender: { id: "u" },
    message: textMessage("hello"),
    receivedAt: "2026-10-27T00:00:00Z"
  };
  it.each(["outgoing", "history"] as const)("%s 可作为记录输入，但不能重新触发智能体", (origin) => {
    expect(router.route({ ...event, origin })).toMatchObject({ shouldRespond: false });
  });
  it("原生与未来 WebUI 的真实入站使用相同触发语义", () => {
    expect(router.route({ ...event, origin: "incoming" })).toMatchObject({ shouldRespond: true });
    expect(router.route({ ...event, platform: "webui", origin: "incoming" })).toMatchObject({ shouldRespond: true });
  });
});
