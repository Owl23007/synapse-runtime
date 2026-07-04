export type Platform = "qq" | "telegram" | "discord" | "webhook" | "cli" | "mobile";

export type ConversationKind = "private" | "group" | "channel" | "system";

export interface ConversationRef {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly title?: string;
}

export interface SenderRef {
  readonly id: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
}

export type MessageType = "text" | "image" | "file" | "audio" | "video" | "mixed";

export type MessageSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly target?: "user" | "all" | "unknown"; readonly userId?: string; readonly label?: string }
  | { readonly type: "reply"; readonly messageId?: string; readonly eventId?: string; readonly sequence?: number }
  | {
      readonly type: "image";
      readonly url?: string;
      readonly fileId?: string;
      readonly localPath?: string;
      readonly alt?: string;
    }
  | {
      readonly type: "file";
      readonly name: string;
      readonly url?: string;
      readonly fileId?: string;
      readonly mimeType?: string;
      readonly sizeBytes?: number;
    }
  | { readonly type: "audio"; readonly url?: string; readonly fileId?: string; readonly durationMs?: number }
  | { readonly type: "video"; readonly url?: string; readonly fileId?: string; readonly durationMs?: number };

export interface SynapseMessage {
  readonly id?: string;
  readonly type: MessageType;
  readonly segments: readonly MessageSegment[];
  readonly replyTo?: MessageReplyRef;
  readonly raw?: unknown;
}

export interface MessageReplyRef {
  readonly messageId?: string;
  readonly eventId?: string;
  readonly sequence?: number;
}

export type ChannelEventType =
  | "message.created"
  | "message.deleted"
  | "member.joined"
  | "member.left"
  | "notice";

export interface SynapseChannelEvent {
  readonly id: string;
  readonly platform: Platform;
  readonly channelId: string;
  readonly eventType: ChannelEventType;
  readonly conversation: ConversationRef;
  readonly sender: SenderRef;
  readonly message?: SynapseMessage;
  readonly triggerHint?: ChannelTriggerHint;
  readonly adapterCapabilities?: AdapterCapabilities;
  readonly raw?: unknown;
  readonly receivedAt: string;
}

export interface ChannelTriggerHint {
  readonly platformMentionedBot?: boolean;
  readonly repliedToBot?: boolean;
  readonly platformEventType?: string;
  readonly selfUserId?: string;
  readonly replyTargetMessageId?: string;
}

export interface AdapterCapabilities {
  readonly mentionUser?: boolean;
  readonly mentionAll?: boolean;
  readonly selfIdFromEvent?: boolean;
  readonly outgoingMessageId?: boolean;
  readonly incomingReplyTarget?: boolean;
  readonly platformMentionedBotHint?: boolean;
  readonly replyToBot?: "yes" | "no" | "conditional";
  readonly passiveReplyWindowSeconds?: number;
}

export function textMessage(text: string, id?: string): SynapseMessage {
  return {
    ...(id === undefined ? {} : { id }),
    type: "text",
    segments: [{ type: "text", text }]
  };
}

export function getTextContent(message: SynapseMessage): string {
  return message.segments
    .filter((segment): segment is Extract<MessageSegment, { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");
}
