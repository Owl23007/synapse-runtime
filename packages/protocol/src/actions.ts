import { CHANNEL_PROTOCOL_SCHEMA_VERSION, type SynapseMessage, type GroupFileUploadAction } from "./types.js";

/** 创建版本化的消息发送动作 */
export function messageSendAction(input: {
  readonly actionId: string;
  readonly channelId: string;
  readonly target: import("./types.js").ChannelActionTarget;
  readonly message: SynapseMessage;
  readonly conversation?: import("./types.js").ConversationRef;
  readonly replyTo?: import("./types.js").MessageReplyRef;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}): import("./types.js").MessageSendAction {
  return {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionId: input.actionId,
    actionType: "message.send",
    channelId: input.channelId,
    target: input.target,
    message: input.message,
    ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

/** 创建群文件上传动作，字节内容仅用于内存执行，不承载持久化或恢复策略 */
export function groupFileUploadAction(
  input: Omit<GroupFileUploadAction, "schemaVersion" | "actionType" | "createdAt"> & { readonly createdAt?: string }
): GroupFileUploadAction {
  return {
    ...input,
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionType: "file.upload",
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}
