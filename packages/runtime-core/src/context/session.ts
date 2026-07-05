import { createHash } from "node:crypto";
import { getTextContent, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { ConversationType } from "./types.js";

export function conversationTypeFromEvent(event: SynapseChannelEvent): ConversationType {
  return event.conversation.kind;
}

export function buildSessionId(event: SynapseChannelEvent, provider: string): string {
  return `${event.platform}:${provider}:${event.channelId}:${conversationTypeFromEvent(event)}:${event.conversation.id}`;
}

export function buildSourceEventId(event: SynapseChannelEvent, provider: string): string {
  const messageId = normalizeStableId(event.message?.id);
  if (messageId !== undefined) {
    return messageId;
  }

  const eventId = normalizeStableId(event.id);
  if (eventId !== undefined && !looksGeneratedFromWallClock(eventId)) {
    return eventId;
  }

  const roundedReceivedAt = roundedIsoTimestamp(event.receivedAt);
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
        text,
        roundedReceivedAt
      ].join("\u001f")
    )
    .digest("hex")
    .slice(0, 32);

  return `best-effort:${digest}`;
}

export function normalizeMessageId(id: unknown): string | undefined {
  if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
    return undefined;
  }

  const normalized = String(id).trim();
  return normalized.length === 0 ? undefined : normalized;
}

export function eventProcessKey(input: {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId: string;
}): string {
  return [
    input.platform,
    input.provider,
    input.channelId,
    input.conversationType,
    input.conversationId,
    input.sourceEventId
  ].join(":");
}

function normalizeStableId(id: string | undefined): string | undefined {
  const normalized = id?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function looksGeneratedFromWallClock(id: string): boolean {
  return /:\d{13}$/.test(id);
}

function roundedIsoTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  const ms = Number.isNaN(parsed) ? Date.now() : parsed;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}
