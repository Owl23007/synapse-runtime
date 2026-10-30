import type {
  ChannelActionTarget,
  ChannelOutputActionBase,
  ConversationRef,
  SenderRef,
  SynapseMessage
} from "./types.js";

/** 原生资源动作不依赖某个平台是否提供对应接口 */
export type ChannelResourceActionType =
  | "message.get"
  | "message.list"
  | "message.forward"
  | "message.pin"
  | "message.unpin"
  | "message.read"
  | "message.stream"
  | "file.get"
  | "file.list"
  | "file.delete"
  | "conversation.get"
  | "conversation.list"
  | "conversation.create"
  | "conversation.update"
  | "conversation.leave"
  | "member.get"
  | "member.list"
  | "member.update"
  | "member.remove"
  | "interaction.respond"
  | "typing.set";

/** 原生分页参数，游标由提供数据的服务解释，不能混用平台游标与数据库主键 */
export interface ChannelPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

/** 原生可查询消息，外部消息标识与会话共同定位资源 */
export interface ChannelMessageRecord {
  readonly id: string;
  readonly conversation: ConversationRef;
  readonly message: SynapseMessage;
  readonly sender?: SenderRef;
  readonly origin?: "incoming" | "outgoing" | "history";
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** 原生文件引用，上传凭据和可过期下载地址不能冒充永久文件标识 */
export interface ChannelFileRef {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly url?: string;
  readonly expiresAt?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** 原生成员资料，禁言截止时间使用绝对时间以避免平台秒数单位泄漏 */
export interface ChannelMember {
  readonly user: SenderRef;
  readonly roles?: readonly string[];
  readonly nickname?: string;
  readonly mutedUntil?: string | null;
}

/** 查询与管理动作的公共定位字段，身份和权限由接入服务确认 */
export interface ChannelResourceActionBase extends ChannelOutputActionBase {
  readonly target: ChannelActionTarget;
}

/** 消息查询、转发、置顶和已读动作 */
export type ChannelMessageResourceAction =
  | (ChannelResourceActionBase & {
      readonly actionType: "message.get" | "message.pin" | "message.unpin" | "message.read";
      readonly targetMessageId: string;
    })
  | (ChannelResourceActionBase & { readonly actionType: "message.list"; readonly page?: ChannelPageRequest })
  | (ChannelResourceActionBase & {
      readonly actionType: "message.forward";
      readonly source: ChannelActionTarget;
      readonly targetMessageIds: readonly string[];
    })
  | (ChannelResourceActionBase & {
      readonly actionType: "message.stream";
      readonly streamId: string;
      readonly sequence: number;
      readonly state: "open" | "update" | "complete" | "cancelled";
      readonly message: SynapseMessage;
    });

/** 文件读取、列表和删除分别建模，删除消息不隐含删除附件 */
export type ChannelFileResourceAction =
  | (ChannelResourceActionBase & {
      readonly actionType: "file.get" | "file.delete";
      readonly fileId: string;
      readonly busid?: string;
    })
  | (ChannelResourceActionBase & {
      readonly actionType: "file.list";
      readonly page?: ChannelPageRequest;
      readonly folderId?: string;
    });

/** 会话资源动作，创建时 target 是父会话或目标命名空间，由接入服务解释 */
export type ChannelConversationAction =
  | (ChannelResourceActionBase & { readonly actionType: "conversation.get" | "conversation.leave" })
  | (ChannelResourceActionBase & { readonly actionType: "conversation.list"; readonly page?: ChannelPageRequest })
  | (ChannelResourceActionBase & {
      readonly actionType: "conversation.create" | "conversation.update";
      readonly properties: {
        readonly title?: string;
        readonly description?: string;
        readonly extensions?: Readonly<Record<string, unknown>>;
      };
    });

/** 成员资料、角色与禁言通过原生字段表达，平台额外约束仍由 adapter 校验 */
export type ChannelMemberAction =
  | (ChannelResourceActionBase & { readonly actionType: "member.get" | "member.remove"; readonly userId: string })
  | (ChannelResourceActionBase & { readonly actionType: "member.list"; readonly page?: ChannelPageRequest })
  | (ChannelResourceActionBase & {
      readonly actionType: "member.update";
      readonly userId: string;
      readonly changes: {
        readonly nickname?: string;
        readonly roles?: readonly string[];
        readonly mutedUntil?: string | null;
      };
    });

/** 交互响应保留原生内容，不使用平台回调签名作为业务标识 */
export interface ChannelInteractionAction extends ChannelResourceActionBase {
  readonly actionType: "interaction.respond";
  readonly interactionId: string;
  readonly response: { readonly status: "accepted" | "rejected"; readonly message?: SynapseMessage };
}

/** 输入状态是独立短暂信号，不创建聊天消息或运行记录 */
export interface ChannelTypingAction extends ChannelResourceActionBase {
  readonly actionType: "typing.set";
  readonly active: boolean;
  readonly durationMs?: number;
}

/** 完整原生资源动作集合，未实现的平台映射必须明确拒绝而不能缩小此集合 */
export type ChannelResourceAction =
  | ChannelMessageResourceAction
  | ChannelFileResourceAction
  | ChannelConversationAction
  | ChannelMemberAction
  | ChannelInteractionAction
  | ChannelTypingAction;

/** 原生分页结果，nextCursor 缺省表示没有后续页 */
export interface ChannelPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** 统一查询结果使用可辨识联合，供后续 WebUI 等客户端按资源类型消费 */
export type ChannelResourceResult =
  | { readonly kind: "message"; readonly message: ChannelMessageRecord }
  | ({ readonly kind: "messages" } & ChannelPage<ChannelMessageRecord>)
  | { readonly kind: "file"; readonly file: ChannelFileRef }
  | ({ readonly kind: "files" } & ChannelPage<ChannelFileRef>)
  | { readonly kind: "conversation"; readonly conversation: ConversationRef }
  | ({ readonly kind: "conversations" } & ChannelPage<ConversationRef>)
  | { readonly kind: "member"; readonly member: ChannelMember }
  | ({ readonly kind: "members" } & ChannelPage<ChannelMember>);
