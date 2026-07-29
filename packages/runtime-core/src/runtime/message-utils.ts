import type { ChannelTarget } from "@synapse/runtime-channel";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { OutputPolicy } from "../output/policy.js";

/** 将频道事件转换为发送目标 */
export function targetFromEvent(event: SynapseChannelEvent): ChannelTarget {
  if (event.conversation.kind === "private") {
    return { type: "private", userId: event.conversation.id };
  }
  if (event.conversation.kind === "group") {
    return { type: "group", groupId: event.conversation.id };
  }
  return { type: "channel", channelId: event.conversation.id };
}

/** 根据发送目标生成权限动作 */
export function channelSendAction(target: ChannelTarget): string {
  if (target.type === "private") {
    return "channel.qq.send_private_message";
  }
  if (target.type === "group") {
    return "channel.qq.send_group_message";
  }
  return "channel.qq.send_channel_message";
}

/** 为输出消息补充回复上下文 */
export function withReplyContext(
  message: SynapseMessage,
  event: SynapseChannelEvent,
  now: number = Date.now()
): SynapseMessage {
  const passiveWindowSeconds = event.adapterCapabilities?.passiveReplyWindowSeconds;
  if (passiveWindowSeconds !== undefined) {
    const receivedAt = Date.parse(event.receivedAt);
    if (!Number.isFinite(receivedAt) || now - receivedAt >= passiveWindowSeconds * 1000) {
      const { replyTo: _expiredReply, ...withoutReply } = message;
      return withoutReply;
    }
  }

  return {
    ...message,
    replyTo: {
      ...(event.message?.id === undefined ? {} : { messageId: event.message.id }),
      eventId: event.id
    }
  };
}

/** 生成适合日志记录的事件摘要 */
export function summarizeEvent(event: SynapseChannelEvent): Readonly<Record<string, unknown>> {
  return {
    eventId: event.id,
    platform: event.platform,
    channelId: event.channelId,
    eventType: event.eventType,
    conversation: event.conversation,
    sender: event.sender,
    receivedAt: event.receivedAt,
    message: event.message === undefined ? undefined : summarizeMessage(event.message)
  };
}

/** 生成适合日志记录的消息摘要 */
export function summarizeMessage(message: SynapseMessage): Readonly<Record<string, unknown>> {
  const text = message.segments
    .filter(
      (segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text"
    )
    .map((segment) => segment.text)
    .join("");

  return {
    id: message.id,
    type: message.type,
    segmentTypes: message.segments.map((segment) => segment.type),
    textLength: text.length,
    textPreview: previewText(text),
    replyTo: message.replyTo
  };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

/** 提取消息中的全部文本片段 */
export function getText(message: SynapseMessage | undefined): string {
  if (message === undefined) {
    return "";
  }
  return message.segments
    .filter(
      (segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text"
    )
    .map((segment) => segment.text)
    .join("");
}

/** 创建纯文本消息 */
export function textMessage(text: string): SynapseMessage {
  return {
    type: "text",
    segments: [{ type: "text", text }]
  };
}

/** 根据输出策略生成保守文本响应 */
export function conservativeResponse(message: SynapseMessage, policy: OutputPolicy): SynapseMessage {
  return {
    ...message,
    segments: [{ type: "text", text: getText(message).slice(0, policy.maxChars) }]
  };
}
