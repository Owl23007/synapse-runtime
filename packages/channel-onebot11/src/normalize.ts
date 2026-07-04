import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import { oneBot11SegmentsToSynapseSegments } from "./message.js";
import { isRecord, numberFromUnknown, stringFromUnknown } from "./utils.js";

export function normalizeOneBot11Event(
  channelId: string,
  payload: unknown
): SynapseChannelEvent | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (payload.post_type !== "message" && payload.post_type !== "message_sent") {
    return undefined;
  }

  const messageType = stringFromUnknown(payload.message_type);
  if (messageType !== "private" && messageType !== "group") {
    return undefined;
  }

  const sender = isRecord(payload.sender) ? payload.sender : undefined;
  const senderId = stringFromUnknown(payload.user_id) ?? stringFromUnknown(sender?.user_id);
  if (senderId === undefined) {
    return undefined;
  }

  const conversation = conversationFromPayload(payload, messageType, sender);
  if (conversation === undefined) {
    return undefined;
  }

  const messageId = stringFromUnknown(payload.message_id);
  const selfUserId = stringFromUnknown(payload.self_id);
  const timestamp = numberFromUnknown(payload.time);
  const senderName = stringFromUnknown(sender?.card)?.trim() || stringFromUnknown(sender?.nickname)?.trim() || undefined;
  const senderRole = stringFromUnknown(sender?.role);
  const rawMessage = stringFromUnknown(payload.raw_message);
  const segments = oneBot11SegmentsToSynapseSegments(payload.message, rawMessage);
  const replySegment = segments.find((segment): segment is Extract<typeof segments[number], { type: "reply" }> => segment.type === "reply");
  const messageTypeForSynapse = segments.some((segment) => segment.type !== "text") ? "mixed" : "text";

  return {
    id: `${channelId}:${messageId ?? `${payload.post_type}:${payload.message_type}:${Date.now()}`}`,
    platform: "qq",
    channelId,
    eventType: "message.created",
    conversation,
    sender: {
      id: senderId,
      ...(senderName === undefined ? {} : { displayName: senderName }),
      ...(senderRole === undefined ? {} : { roles: [senderRole] })
    },
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: messageTypeForSynapse,
      segments,
      ...(replySegment?.messageId === undefined ? {} : { replyTo: { messageId: replySegment.messageId } }),
      raw: payload.message ?? payload.raw_message
    },
    triggerHint: {
      platformEventType: `${payload.post_type}.${messageType}`,
      ...(selfUserId === undefined ? {} : { selfUserId }),
      ...(replySegment?.messageId === undefined ? {} : { replyTargetMessageId: replySegment.messageId })
    },
    adapterCapabilities: {
      mentionUser: true,
      mentionAll: true,
      selfIdFromEvent: selfUserId !== undefined,
      outgoingMessageId: true,
      incomingReplyTarget: true,
      replyToBot: "yes"
    },
    raw: payload,
    receivedAt: timestamp === undefined ? new Date().toISOString() : new Date(timestamp * 1000).toISOString()
  };
}

function conversationFromPayload(
  payload: Readonly<Record<string, unknown>>,
  messageType: "private" | "group",
  sender: Readonly<Record<string, unknown>> | undefined
): SynapseChannelEvent["conversation"] | undefined {
  if (messageType === "private") {
    const userId = stringFromUnknown(payload.user_id) ?? stringFromUnknown(sender?.user_id);
    return userId === undefined ? undefined : { id: userId, kind: "private" };
  }

  const groupId = stringFromUnknown(payload.group_id);
  if (groupId === undefined) {
    return undefined;
  }

  return {
    id: groupId,
    kind: "group",
    ...(typeof sender?.card === "string" && sender.card.length > 0
      ? { title: sender.card }
      : {})
  };
}
