import type { ChannelTarget } from "@synapse/runtime-channel";
import type { SynapseMessage } from "@synapse/runtime-protocol";
import { stringFromUnknown } from "./utils.js";

export function createQqOfficialSendBody(
  target: ChannelTarget,
  message: SynapseMessage,
  content: string
): Readonly<Record<string, unknown>> {
  const reply = message.replyTo;
  const messageId = reply?.messageId;
  const replyFields = {
    ...(messageId !== undefined
      ? { msg_id: messageId }
      : reply?.eventId === undefined
        ? {}
        : { event_id: reply.eventId }),
    msg_seq: reply?.sequence ?? (messageId === undefined ? 1 : createQqOfficialMessageSequence(messageId))
  };

  if (target.type === "channel") {
    return {
      content,
      ...replyFields
    };
  }

  return {
    content,
    msg_type: 0,
    ...replyFields
  };
}

export function renderTextMessage(message: SynapseMessage): string {
  const text = message.segments
    .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
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

function createQqOfficialMessageSequence(messageId: string): number {
  let hash = 0;

  for (let index = 0; index < messageId.length; index += 1) {
    hash = (hash * 31 + messageId.charCodeAt(index)) >>> 0;
  }

  return (hash ^ Date.now() ^ Math.floor(Math.random() * 65_536)) & 0xffff;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
