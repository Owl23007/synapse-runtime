/** 消息来源标识，原生与 WebUI 入口不借用外部平台的名称 */
export type Platform = "native" | "webui" | "qq" | "telegram" | "discord" | "webhook" | "cli" | "mobile";

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

/** 完整原生消息，平台仅映射可无损表达的片段与控件子集 */
export interface SynapseMessage {
  /** 规范消息对象的协议版本，旧调用方可暂不填写 */
  readonly schemaVersion?: ChannelProtocolSchemaVersion;
  readonly id?: string;
  readonly type: MessageType;
  readonly segments: readonly MessageSegment[];
  readonly replyTo?: MessageReplyRef;
  readonly raw?: unknown;
  /** 交互控件属于原生消息内容，平台只负责将其编码为相应的键盘或组件 */
  readonly components?: readonly MessageComponent[];
}

/** 原生交互控件，平台特有样式放入带命名空间的扩展而不污染基础字段 */
export interface MessageComponent {
  readonly type: "button" | "select" | "input";
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly url?: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 原生回复关联，可选上下文与必须保留的关系分别表达 */
export interface MessageReplyRef {
  /** 默认作为可选交付上下文；必须保留回复关系时显式要求 adapter 支持 */
  readonly required?: boolean;
  readonly messageId?: string;
  readonly eventId?: string;
  readonly sequence?: number;
}

/** 原生事件全集，不按当前接入平台的事件订阅范围裁剪 */
export type ChannelEventType =
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "reaction.added"
  | "reaction.removed"
  | "member.joined"
  | "member.left"
  | "member.updated"
  | "conversation.created"
  | "conversation.updated"
  | "conversation.deleted"
  | "file.created"
  | "file.deleted"
  | "interaction.created"
  | "typing.changed"
  | "notice"
  | "unknown";

/** 原生事件信封，内容与资源载荷不要求调用方解析平台原始对象 */
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
  /** 入站、平台自发和历史同步分别表达，避免把机器人输出再次当作用户请求 */
  readonly origin?: "incoming" | "outgoing" | "history";
  /** 非消息事件的原生资源信息，不要求上层解析平台 raw */
  readonly resource?: ChannelEventResource;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 原生事件的资源载荷，删除事件无需伪造一条包含空内容的消息 */
export type ChannelEventResource =
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "reaction"; readonly messageId: string; readonly reaction: ReactionRef }
  | { readonly kind: "file"; readonly file: import("./channel-resources.js").ChannelFileRef }
  | { readonly kind: "member"; readonly member: import("./channel-resources.js").ChannelMember }
  | { readonly kind: "conversation"; readonly conversation: ConversationRef }
  | {
      readonly kind: "interaction";
      readonly interactionId: string;
      readonly componentId: string;
      readonly value?: string;
    }
  | { readonly kind: "typing"; readonly active: boolean; readonly durationMs?: number };

export interface ChannelTriggerHint {
  readonly platformMentionedBot?: boolean;
  readonly repliedToBot?: boolean;
  readonly platformEventType?: string;
  readonly selfUserId?: string;
  readonly replyTargetMessageId?: string;
}

/** 当前入站事件的路由与回复上下文，不作为平台动作的能力授权 */
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
export type ChannelActionType =
  | "message.send"
  | "message.edit"
  | "message.delete"
  | "reaction.add"
  | "reaction.remove"
  | "file.upload"
  | import("./channel-resources.js").ChannelResourceActionType
  | "platform.execute";

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
  readonly reaction: ReactionRef;
}

/** 原生表情回应引用，与消息中的 emoji 片段保持不同语义 */
export interface ReactionRef {
  readonly namespace?: string;
  readonly id: string;
  readonly name?: string;
}

/** Runtime 产生的统一出站动作模型 */
export type ChannelOutputAction =
  | MessageSendAction
  | MessageEditAction
  | MessageDeleteAction
  | ReactionAction
  | FileUploadAction
  | import("./channel-resources.js").ChannelResourceAction
  | PlatformAction;

/** 显式命名的平台扩展动作，不能隐式授权或替代标准动作 */
export interface PlatformAction extends ChannelOutputActionBase {
  readonly actionType: "platform.execute";
  readonly capability: `${string}:${string}`;
  readonly target: ChannelActionTarget;
  readonly params: Readonly<Record<string, unknown>>;
}

/** 原生文件上传动作适用于所有目标，持久化与恢复由 Runtime 管理，不能直接序列化字节 */
export interface FileUploadAction extends ChannelOutputActionBase {
  readonly actionType: "file.upload";
  readonly target: ChannelActionTarget;
  readonly file: GroupFileUpload;
}

/** 兼容现有群文件交付调用，原生 file.upload 本身不局限于群目标 */
export interface GroupFileUploadAction extends FileUploadAction {
  readonly target: Extract<ChannelActionTarget, { readonly type: "group" }>;
}

/** 可执行能力的约束，额外平台约束仍由 Adapter 校验 */
export interface ChannelCapabilityConstraints {
  readonly targetTypes?: readonly ChannelActionTarget["type"][];
  readonly messageSegmentTypes?: readonly MessageSegment["type"][];
  readonly maxFileSizeBytes?: number;
  readonly richContentFormats?: readonly Extract<MessageSegment, { readonly type: "rich-content" }>["format"][];
  readonly mentionTargets?: readonly ("user" | "all" | "unknown")[];
  readonly replyContextKinds?: readonly ("message" | "event")[];
  readonly messageComponents?: readonly MessageComponent["type"][];
  readonly maxDeleteAgeSeconds?: number;
  readonly ownMessagesOnly?: boolean;
  /** 覆盖特定目标的额外限制，全局与目标限制必须同时满足 */
  readonly perTarget?: Readonly<Partial<Record<ChannelActionTarget["type"], ChannelCapabilityConstraints>>>;
  readonly [key: string]: unknown;
}

/** 标准动作能力或带命名空间的平台扩展，例如 napcat:upload_group_file */
export type ChannelCapabilityKey = ChannelActionType | "message.receive" | "message.media" | `${string}:${string}`;

/** Channel 能力的验证状态 */
export type CapabilityStatus = "supported" | "partially-supported" | "unsupported" | "unknown";

/** 单项 Channel 能力及其约束 */
export interface ChannelCapability {
  readonly status: CapabilityStatus;
  readonly reason?: string;
  readonly constraints?: ChannelCapabilityConstraints;
  readonly source?: "tested" | "documented" | "blocked" | "unknown";
  /** 标准动作在具体平台的实现来源，扩展实现不等于标准协议原生支持 */
  readonly implementation?: `${string}:${string}`;
}

/** 可落库、可观测的 Channel 能力描述 */
export interface ChannelCapabilityProfile {
  readonly schemaVersion: ChannelProtocolSchemaVersion;
  readonly channelId: string;
  readonly adapterType: string;
  readonly observedAt: string;
  readonly capabilities: Readonly<Partial<Record<ChannelCapabilityKey, ChannelCapability>>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 出站动作终态，uncertain 表示可能已产生平台副作用，不能自动重试 */
export type ChannelActionStatus = "succeeded" | "failed" | "unsupported" | "uncertain";

/** 平台操作的统一回执，未知结果与明确拒绝必须区分，避免恢复时重复交付 */
export type ChannelOperationResult = (
  | {
      readonly status: "succeeded";
      readonly messageId?: string;
      readonly fileId?: string;
      readonly data?: import("./channel-resources.js").ChannelResourceResult;
    }
  | { readonly status: Exclude<ChannelActionStatus, "succeeded">; readonly error: string }
) & {
  /** 仅保留可安全持久化的平台状态，禁止放入令牌或未脱敏响应体 */
  readonly platformReceipt?: { readonly code?: string | number; readonly httpStatus?: number };
};

/** 出站动作结果关联请求标识，不引入第二套平台回执语义 */
export type ChannelActionResult = ChannelOperationResult & {
  readonly schemaVersion: ChannelProtocolSchemaVersion;
  readonly actionId: string;
  readonly actionType: ChannelActionType;
  readonly executedAt: string;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly raw?: unknown;
  readonly extensions?: Readonly<Record<string, unknown>>;
};

/** 上传原生字节内容，不接受仅在 Runtime 宿主可见的文件路径 */
export interface ChannelFileUpload {
  readonly name: string;
  readonly data: Uint8Array;
}

/** 兼容群文件交付调用方，文件内容模型本身不限定会话种类 */
export type GroupFileUpload = ChannelFileUpload;
