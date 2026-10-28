import type { ChannelActionTarget, SynapseMessage } from "@synapse/runtime-protocol";
import { stringFromUnknown } from "./utils.js";

/** 按官方平台目标编码消息正文与被动回复上下文 */
export function createQqOfficialSendBody(
  target: ChannelActionTarget,
  message: SynapseMessage,
  content: string
): Readonly<Record<string, unknown>> {
  const reply = message.replyTo;
  const replyPart = message.segments.find((part) => part.type === "reply");
  const messageId = reply?.messageId ?? replyPart?.messageId;
  const eventId = reply?.eventId ?? replyPart?.eventId;
  const replyFields = {
    ...(messageId !== undefined ? { msg_id: messageId } : eventId === undefined ? {} : { event_id: eventId }),
    // 序号由调用方分配并持久化，随机序号会让同一动作重放时绕过去重
    msg_seq: reply?.sequence ?? replyPart?.sequence ?? 1
  };
  const reference = message.segments.find((part) => part.type === "reference");
  const referenceFields =
    reference?.messageId === undefined ? {} : { message_reference: { message_id: reference.messageId } };
  const markdown = message.segments.find((part) => part.type === "rich-content");
  const contentFields = markdown?.format === "markdown" ? { markdown: { content: markdown.value } } : { content };

  if (target.type === "channel") {
    return {
      ...contentFields,
      ...replyFields,
      ...referenceFields
    };
  }

  return {
    ...contentFields,
    msg_type: markdown === undefined ? 0 : 2,
    ...replyFields,
    ...referenceFields
  };
}

export function renderTextMessage(message: SynapseMessage): string {
  const text = message.segments
    .filter(
      (segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text"
    )
    .map((segment) => segment.text)
    .join("");

  if (text.length === 0) {
    throw new Error("QQ official adapter can only send messages with text content in this MVP.");
  }

  return text;
}

export function extractMessageId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return stringFromUnknown(value.id) ?? stringFromUnknown(value.message_id);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
