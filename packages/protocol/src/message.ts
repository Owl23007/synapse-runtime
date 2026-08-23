import { CHANNEL_PROTOCOL_SCHEMA_VERSION, type MessageSegment, type SynapseMessage } from "./types.js";

/**
 * 创建仅包含文本片段的规范消息
 */
export function textMessage(text: string, id?: string): SynapseMessage {
  return {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    ...(id === undefined ? {} : { id }),
    type: "text",
    segments: [{ type: "text", text }]
  };
}

/** 创建版本化的文本发送动作 */
export function messageSendAction(input: {
  readonly actionId: string;
  readonly channelId: string;
  readonly target: import("./types.js").ChannelActionTarget;
  readonly message: SynapseMessage;
  readonly conversation?: import("./types.js").ConversationRef;
  readonly replyTo?: import("./types.js").MessageReplyRef;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}): import("./types.js").MessageSendAction {
  return {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionId: input.actionId,
    actionType: "message.send",
    channelId: input.channelId,
    target: input.target,
    message: input.message,
    ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

/**
 * 提取规范消息中的全部文本内容
 */
export function getTextContent(message: SynapseMessage): string {
  return message.segments
    .filter((segment): segment is Extract<MessageSegment, { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");
}
