import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { QqOfficialDispatchPayload, QqOfficialMessagePayload } from "./types.js";
import { isRecord, stringFromUnknown } from "./utils.js";

export function normalizeQqOfficialDispatch(
  channelId: string,
  payload: QqOfficialDispatchPayload
): SynapseChannelEvent | undefined {
  if (payload.op !== undefined && payload.op !== 0) {
    return undefined;
  }

  if (payload.t === undefined || payload.d === undefined || !isRecord(payload.d)) {
    return undefined;
  }

  const messagePayload = payload.d as QqOfficialMessagePayload;
  const conversation = conversationFromPayload(payload.t, messagePayload);

  if (conversation === undefined) {
    return undefined;
  }

  const eventId =
    stringFromUnknown(payload.id) ??
    stringFromUnknown(messagePayload.event_id) ??
    stringFromUnknown(messagePayload.id) ??
    `${payload.t}:${Date.now()}`;
  const messageId = stringFromUnknown(messagePayload.msg_id) ?? stringFromUnknown(messagePayload.id);
  const replyTargetMessageId = replyTargetMessageIdFromPayload(messagePayload);

  return {
    id: eventId,
    platform: "qq",
    channelId,
    eventType: "message.created",
    conversation,
    sender: {
      id:
        stringFromUnknown(messagePayload.author?.user_openid) ??
        stringFromUnknown(messagePayload.author?.id) ??
        stringFromUnknown(messagePayload.user_openid) ??
        "unknown",
      ...(messagePayload.author?.username === undefined ? {} : { displayName: messagePayload.author.username })
    },
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: "text",
      segments: [
        { type: "text", text: messagePayload.content ?? "" },
        ...mentionSegmentsFromPayload(payload.t, messagePayload)
      ],
      ...(replyTargetMessageId === undefined ? {} : { replyTo: { messageId: replyTargetMessageId } }),
      raw: messagePayload.raw_message ?? payload.d
    },
    triggerHint: {
      platformEventType: payload.t,
      platformMentionedBot: payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "AT_MESSAGE_CREATE",
      ...(replyTargetMessageId === undefined ? {} : { replyTargetMessageId })
    },
    adapterCapabilities: adapterCapabilitiesForEvent(payload.t, replyTargetMessageId),
    raw: payload,
    receivedAt: messagePayload.timestamp ?? new Date().toISOString()
  };
}

function conversationFromPayload(
  eventType: string,
  payload: QqOfficialMessagePayload
): SynapseChannelEvent["conversation"] | undefined {
  if (eventType === "C2C_MESSAGE_CREATE" || eventType === "DIRECT_MESSAGE_CREATE") {
    const userId = stringFromUnknown(payload.user_openid) ?? stringFromUnknown(payload.author?.user_openid);
    const id = userId ?? stringFromUnknown(payload.channel_id) ?? stringFromUnknown(payload.guild_id);
    return id === undefined ? undefined : { id, kind: "private" };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    const groupId = stringFromUnknown(payload.group_openid) ?? stringFromUnknown(payload.group_id);
    return groupId === undefined ? undefined : { id: groupId, kind: "group" };
  }

  if (eventType === "AT_MESSAGE_CREATE" || eventType === "MESSAGE_CREATE") {
    const id = stringFromUnknown(payload.channel_id) ?? stringFromUnknown(payload.guild_id);
    return id === undefined ? undefined : { id, kind: "channel" };
  }

  return undefined;
}

function mentionSegmentsFromPayload(eventType: string, payload: QqOfficialMessagePayload): SynapseMessage["segments"] {
  const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
  const segments = mentions
    .map((mention) => mentionSegmentFromUnknown(mention))
    .filter(
      (
        segment
      ): segment is {
        readonly type: "mention";
        readonly target?: "user" | "all" | "unknown";
        readonly userId?: string;
        readonly label?: string;
      } => segment !== undefined
    );

  if (segments.length > 0) {
    return segments;
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "AT_MESSAGE_CREATE") {
    return [{ type: "mention", target: "unknown" }];
  }

  return [];
}

function mentionSegmentFromUnknown(mention: unknown):
  | {
      readonly type: "mention";
      readonly target?: "user" | "all" | "unknown";
      readonly userId?: string;
      readonly label?: string;
    }
  | undefined {
  if (typeof mention === "string" && mention.length > 0) {
    return mention === "all"
      ? { type: "mention", target: "all" }
      : { type: "mention", target: "user", userId: mention };
  }

  if (!isRecord(mention)) {
    return undefined;
  }

  const userId =
    stringFromUnknown(mention.id) ??
    stringFromUnknown(mention.user_id) ??
    stringFromUnknown(mention.user_openid) ??
    stringFromUnknown(mention.openid) ??
    stringFromUnknown(mention.member_openid);
  const label = stringFromUnknown(mention.username) ?? stringFromUnknown(mention.name);

  if (userId === undefined && label === undefined) {
    return undefined;
  }

  return {
    type: "mention",
    target: userId === undefined ? "unknown" : "user",
    ...(userId === undefined ? {} : { userId }),
    ...(label === undefined ? {} : { label })
  };
}

function replyTargetMessageIdFromPayload(payload: QqOfficialMessagePayload): string | undefined {
  return (
    messageIdFromUnknown(payload.message_reference) ??
    messageIdFromUnknown(payload.referenced_message) ??
    messageIdFromUnknown(payload.reply)
  );
}

function messageIdFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return (
    stringFromUnknown(value.message_id) ??
    stringFromUnknown(value.msg_id) ??
    stringFromUnknown(value.id) ??
    stringFromUnknown(value.messageId)
  );
}

function adapterCapabilitiesForEvent(
  eventType: string,
  replyTargetMessageId: string | undefined
): NonNullable<SynapseChannelEvent["adapterCapabilities"]> {
  if (eventType === "C2C_MESSAGE_CREATE" || eventType === "DIRECT_MESSAGE_CREATE") {
    return {
      mentionUser: false,
      mentionAll: false,
      outgoingMessageId: true,
      incomingReplyTarget: replyTargetMessageId !== undefined,
      platformMentionedBotHint: true,
      replyToBot: replyTargetMessageId === undefined ? "no" : "conditional",
      passiveReplyWindowSeconds: 3600
    };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    return {
      mentionUser: false,
      mentionAll: false,
      outgoingMessageId: true,
      incomingReplyTarget: replyTargetMessageId !== undefined,
      platformMentionedBotHint: eventType === "GROUP_AT_MESSAGE_CREATE",
      replyToBot: replyTargetMessageId === undefined ? "no" : "conditional",
      passiveReplyWindowSeconds: 300
    };
  }

  return {
    mentionUser: true,
    mentionAll: false,
    outgoingMessageId: true,
    incomingReplyTarget: replyTargetMessageId !== undefined,
    platformMentionedBotHint: eventType === "AT_MESSAGE_CREATE",
    replyToBot: replyTargetMessageId === undefined ? "no" : "conditional"
  };
}
