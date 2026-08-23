export type Platform = "qq" | "telegram" | "discord" | "webhook" | "cli" | "mobile";

/** Channel Protocol v1 的稳定 Schema 版本
 *
 * 协议对象携带版本是为了让原始事件、重放数据和未来的兼容解析不依赖
 * 当前运行时代码版本
 */
export const CHANNEL_PROTOCOL_SCHEMA_VERSION = "channel-protocol/v1" as const;

/** Channel Protocol v1 的版本字面量类型 */
export type ChannelProtocolSchemaVersion = typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;

export type ConversationKind = "private" | "group" | "channel" | "system";

export interface ConversationRef {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly title?: string;
  /** 平台侧会话引用，内部数据库 ID 不应放入协议对象 */
  readonly platform?: Platform;
  readonly channelId?: string;
  readonly parentId?: string;
}

export interface SenderRef {
  readonly id: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
  /** 发送者在平台侧的稳定引用 */
  readonly platform?: Platform;
  readonly channelId?: string;
}

export type MessageType = "text" | "image" | "file" | "audio" | "video" | "mixed";

export type ProtocolPartMetadata =
  | { readonly namespace: string; readonly raw: unknown }
  | { readonly namespace?: never; readonly raw?: never };

export interface UnknownMessagePart {
  readonly type: "unknown";
  readonly namespace: string;
  readonly rawType: string;
  readonly fallbackText: string;
  readonly raw: unknown;
}

type NormalizedMessageSegment =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "mention";
      readonly target?: "user" | "all" | "unknown";
      readonly userId?: string;
      readonly label?: string;
    }
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
  | { readonly type: "video"; readonly url?: string; readonly fileId?: string; readonly durationMs?: number }
  | {
      readonly type: "emoji";
      readonly emojiId?: string;
      readonly name?: string;
      readonly animated?: boolean;
      readonly resource?: string;
      readonly fallbackText?: string;
    }
  | {
      readonly type: "sticker";
      readonly stickerId?: string;
      readonly packId?: string;
      readonly name?: string;
      readonly animated?: boolean;
      readonly resource?: string;
      readonly alt?: string;
    }
  | {
      readonly type: "reference";
      readonly messageId?: string;
      readonly eventId?: string;
      readonly conversationId?: string;
      readonly quotedText?: string;
    }
  | {
      readonly type: "rich-content";
      readonly format: "markdown" | "html" | "json" | "card" | "unknown";
      readonly value: string | Readonly<Record<string, unknown>>;
      readonly alt?: string;
    };

export type MessageSegment = (NormalizedMessageSegment & ProtocolPartMetadata) | UnknownMessagePart;

export interface SynapseMessage {
  /** 规范消息对象的协议版本，旧调用方可暂不填写 */
  readonly schemaVersion?: ChannelProtocolSchemaVersion;
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
  | "message.updated"
  | "message.deleted"
  | "reaction.added"
  | "reaction.removed"
  | "member.joined"
  | "member.left"
  | "notice"
  | "unknown";

export interface SynapseChannelEvent {
  /** 规范事件对象的协议版本，旧 Adapter 事件允许缺省以保持兼容 */
  readonly schemaVersion?: ChannelProtocolSchemaVersion;
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
  readonly externalEventId?: string;
  readonly adapterType?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
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

/** 出站动作支持的协议类型 */
export type ChannelActionType = "message.send" | "message.edit" | "message.delete" | "reaction.add" | "reaction.remove";

/** 出站动作所使用的平台目标 */
export type ChannelActionTarget =
  | { readonly type: "private"; readonly userId: string }
  | { readonly type: "group"; readonly groupId: string }
  | { readonly type: "channel"; readonly channelId: string };

/** 出站动作的公共字段 */
export interface ChannelOutputActionBase {
  readonly schemaVersion: ChannelProtocolSchemaVersion;
  readonly actionId: string;
  readonly actionType: ChannelActionType;
  readonly channelId: string;
  readonly conversation?: ConversationRef;
  readonly replyTo?: MessageReplyRef;
  readonly idempotencyKey?: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 向平台发送消息的出站动作 */
export interface MessageSendAction extends ChannelOutputActionBase {
  readonly actionType: "message.send";
  readonly target: ChannelActionTarget;
  readonly message: SynapseMessage;
}

/** 编辑平台消息的出站动作 */
export interface MessageEditAction extends ChannelOutputActionBase {
  readonly actionType: "message.edit";
  readonly target: ChannelActionTarget;
  readonly targetMessageId: string;
  readonly message: SynapseMessage;
}

/** 删除平台消息的出站动作 */
export interface MessageDeleteAction extends ChannelOutputActionBase {
  readonly actionType: "message.delete";
  readonly target: ChannelActionTarget;
  readonly targetMessageId: string;
}

/** 添加或移除平台 Reaction 的出站动作 */
export interface ReactionAction extends ChannelOutputActionBase {
  readonly actionType: "reaction.add" | "reaction.remove";
  readonly target: ChannelActionTarget;
  readonly targetMessageId: string;
  readonly reaction: {
    readonly namespace?: string;
    readonly id: string;
    readonly name?: string;
  };
}

/** Runtime 产生的统一出站动作模型 */
export type ChannelOutputAction = MessageSendAction | MessageEditAction | MessageDeleteAction | ReactionAction;

/** Channel 能力的验证状态 */
export type CapabilityStatus = "supported" | "partially-supported" | "unsupported" | "unknown";

/** 单项 Channel 能力及其约束 */
export interface ChannelCapability {
  readonly status: CapabilityStatus;
  readonly reason?: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly source?: "tested" | "documented" | "blocked" | "unknown";
}

/** 可落库、可观测的 Channel 能力描述 */
export interface ChannelCapabilityProfile {
  readonly schemaVersion: ChannelProtocolSchemaVersion;
  readonly channelId: string;
  readonly adapterType: string;
  readonly observedAt: string;
  readonly capabilities: Readonly<Record<string, ChannelCapability>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 出站动作的统一执行结果 */
export interface ChannelActionResult {
  readonly schemaVersion: ChannelProtocolSchemaVersion;
  readonly actionId: string;
  readonly actionType: ChannelActionType;
  readonly status: "succeeded" | "failed" | "unsupported";
  readonly externalMessageId?: string;
  readonly executedAt: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly raw?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>>;
}
