import { createHash } from "node:crypto";
import { getTextContent, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { ConversationType } from "./types.js";

/**
 * 从频道事件读取会话类型
 */
export function conversationTypeFromEvent(event: SynapseChannelEvent): ConversationType {
  return event.conversation.kind;
}

/**
 * 为频道会话生成稳定的运行时会话标识
 */
export function buildSessionId(event: SynapseChannelEvent, provider: string): string {
  return `${event.platform}:${provider}:${event.channelId}:${conversationTypeFromEvent(event)}:${event.conversation.id}`;
}

/**
 * 为来源事件生成稳定标识并兼容缺失平台标识的事件
 */
export function buildSourceEventId(event: SynapseChannelEvent, provider: string): string {
  const messageId = normalizeStableId(event.message?.id);
  if (messageId !== undefined) {
    return messageId;
  }

  const eventId = normalizeStableId(event.id);
  if (eventId !== undefined && !looksGeneratedFromWallClock(eventId)) {
    return eventId;
  }

  const text = event.message === undefined ? "" : getTextContent(event.message);
  const digest = createHash("sha256")
    .update(
      [
        event.platform,
        provider,
        event.channelId,
        conversationTypeFromEvent(event),
        event.conversation.id,
        event.sender.id,
        event.eventType,
        text,
        event.receivedAt,
        jsonFingerprint(event.message?.segments),
        jsonFingerprint(event.triggerHint),
        jsonFingerprint(event.raw)
      ].join("\u001f")
    )
    .digest("hex")
    .slice(0, 32);

  return `best-effort:${digest}`;
}

/**
 * 规范化外部消息标识
 */
export function normalizeMessageId(id: unknown): string | undefined {
  if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
    return undefined;
  }

  const normalized = String(id).trim();
  return normalized.length === 0 ? undefined : normalized;
}

/**
 * 生成事件处理状态的幂等键
 */
export function eventProcessKey(input: {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
}): string {
  return [input.platform, input.provider, input.channelId, input.sourceEventId, input.sourceEventType].join("\u001f");
}

function normalizeStableId(id: string | undefined): string | undefined {
  const normalized = id?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function looksGeneratedFromWallClock(id: string): boolean {
  return /:\d{13}$/.test(id);
}

function jsonFingerprint(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? { $bigint: item.toString() } : item
      ) ?? ""
    );
  } catch {
    return Object.prototype.toString.call(value);
  }
}
