import { CHANNEL_PROTOCOL_SCHEMA_VERSION, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { oneBot11SegmentsToSynapseSegments } from "./message.js";
import { isRecord, numberFromUnknown, stringFromUnknown } from "./utils.js";
import type { ChannelFileNotice } from "@synapse/runtime-protocol";

/** 只归一化实际文件通知，拒绝不完整平台事实且不生成消息 */
export function normalizeOneBot11FileNotice(
  channelId: string,
  provider: string,
  payload: unknown
): ChannelFileNotice | undefined {
  if (
    !isRecord(payload) ||
    payload.post_type !== "notice" ||
    payload.notice_type !== "group_upload" ||
    !isRecord(payload.file)
  )
    return undefined;
  const groupId = stringFromUnknown(payload.group_id);
  const fileId = stringFromUnknown(payload.file.id);
  const name = stringFromUnknown(payload.file.name);
  const time = numberFromUnknown(payload.time);
  const size = numberFromUnknown(payload.file.size);
  const busid = stringFromUnknown(payload.file.busid);
  const senderId = stringFromUnknown(payload.user_id);
  const sourceEventId = stringFromUnknown(payload.message_id) ?? stringFromUnknown(payload.id);
  if (!groupId || !fileId || !name || (time !== undefined && !Number.isFinite(new Date(time * 1000).getTime())))
    return undefined;
  return {
    channelId,
    provider,
    platform: "qq",
    conversation: { kind: "group", id: groupId },
    file: {
      fileId,
      name,
      ...(size !== undefined && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
      ...(busid ? { busid } : {})
    },
    observedAt: time === undefined ? new Date().toISOString() : new Date(time * 1000).toISOString(),
    ...(senderId ? { senderId } : {}),
    ...(sourceEventId ? { sourceEventId } : {})
  };
}

/** 将平台消息归一化为完整原生内容，同时保留自发消息来源供运行时防止回复循环 */
export function normalizeOneBot11Event(channelId: string, payload: unknown): SynapseChannelEvent | undefined {
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

  const conversation = conversationFromPayload(channelId, payload, messageType, sender);
  if (conversation === undefined) {
    return undefined;
  }

  const messageId = stringFromUnknown(payload.message_id);
  const externalEventId = stringFromUnknown(payload.id) ?? messageId;
  const selfUserId = stringFromUnknown(payload.self_id);
  const timestamp = numberFromUnknown(payload.time);
  const senderName =
    stringFromUnknown(sender?.card)?.trim() || stringFromUnknown(sender?.nickname)?.trim() || undefined;
  const senderRole = stringFromUnknown(sender?.role);
  const rawMessage = stringFromUnknown(payload.raw_message);
  const segments = oneBot11SegmentsToSynapseSegments(payload.message, rawMessage);
  const replySegment = segments.find(
    (segment): segment is Extract<(typeof segments)[number], { type: "reply" }> => segment.type === "reply"
  );
  const messageTypeForSynapse = segments.some((segment) => segment.type !== "text") ? "mixed" : "text";

  return {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    id: `${channelId}:${messageId ?? `${payload.post_type}:${payload.message_type}:${Date.now()}`}`,
    ...(externalEventId === undefined ? {} : { externalEventId }),
    adapterType: "onebot11",
    platform: "qq",
    channelId,
    eventType: "message.created",
    origin: payload.post_type === "message_sent" ? "outgoing" : "incoming",
    conversation,
    sender: {
      id: senderId,
      ...(senderName === undefined ? {} : { displayName: senderName }),
      ...(senderRole === undefined ? {} : { roles: [senderRole] }),
      platform: "qq",
      channelId
    },
    message: {
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
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
  channelId: string,
  payload: Readonly<Record<string, unknown>>,
  messageType: "private" | "group",
  sender: Readonly<Record<string, unknown>> | undefined
): SynapseChannelEvent["conversation"] | undefined {
  if (messageType === "private") {
    const userId = stringFromUnknown(payload.user_id) ?? stringFromUnknown(sender?.user_id);
    return userId === undefined ? undefined : { id: userId, kind: "private", platform: "qq", channelId };
  }

  const groupId = stringFromUnknown(payload.group_id);
  if (groupId === undefined) {
    return undefined;
  }

  return {
    id: groupId,
    kind: "group",
    platform: "qq",
    channelId,
    ...(typeof sender?.card === "string" && sender.card.length > 0 ? { title: sender.card } : {})
  };
}
