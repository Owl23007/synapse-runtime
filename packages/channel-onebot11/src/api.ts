import type {
  ChannelActionTarget,
  ChannelOperationResult,
  MessageSegment,
  SynapseMessage
} from "@synapse/runtime-protocol";
import { isOneBot11Success } from "./codec.js";
import { createOneBot11SendParams } from "./message.js";
import { normalizeOneBot11Event } from "./normalize.js";
import type { OneBot11Connection } from "./transport.js";
import { isRecord, stringFromUnknown } from "./utils.js";

/** 当前标准消息编码器能完整处理的片段，不包含任何文件扩展 */
export const ONEBOT11_MESSAGE_SEGMENT_TYPES = [
  "text",
  "mention",
  "reply",
  "image"
] as const satisfies readonly MessageSegment["type"][];

/** OneBot11 标准消息 API，不导入 NapCat 或文件上传扩展 */
export class OneBot11Api {
  constructor(private readonly connection: OneBot11Connection) {}

  /** 编码失败属于发送前失败，传输失败与异步回执属于结果未知 */
  async sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult> {
    if (
      target.type === "channel" ||
      message.components?.length ||
      (message.replyTo?.required && message.replyTo.messageId === undefined) ||
      message.segments.some((part) => !ONEBOT11_MESSAGE_SEGMENT_TYPES.some((type) => type === part.type))
    ) {
      return {
        status: "unsupported",
        error: "OneBot 11 standard message API does not support this target or segment."
      };
    }
    let params: Readonly<Record<string, unknown>>;
    try {
      params = createOneBot11SendParams(target, message);
    } catch {
      return { status: "failed", error: "OneBot 11 message has no sendable content." };
    }
    try {
      const response = await this.connection.call("send_msg", params);
      if (isOneBot11Success(response)) {
        const messageId = isRecord(response.data) ? stringFromUnknown(response.data.message_id) : undefined;
        if (messageId === undefined)
          return {
            status: "uncertain",
            error: "OneBot 11 send did not return a message identifier; verify delivery before retrying."
          };
        return { status: "succeeded", ...(messageId === undefined ? {} : { messageId }) };
      }
      if (response.status === "failed") {
        return {
          status: "failed",
          error: `OneBot 11 send_msg failed (retcode ${response.retcode ?? "unknown"}).`,
          platformReceipt: { ...(response.retcode === undefined ? {} : { code: response.retcode }) }
        };
      }
      return { status: "uncertain", error: "消息发送未获得明确终态，请核对后再决定是否重新发送" };
    } catch {
      return { status: "uncertain", error: "消息发送回执未确认，请核对后再决定是否重新发送" };
    }
  }

  /** 将原生撤回映射到标准 delete_msg，权限和时限由平台校验 */
  async deleteMessage(target: ChannelActionTarget, messageId: string): Promise<ChannelOperationResult> {
    if (target.type === "channel")
      return { status: "unsupported", error: "OneBot 11 does not support channel targets." };
    if (!messageId) return { status: "failed", error: "Message identifier is required." };
    try {
      const response = await this.connection.call("delete_msg", { message_id: messageId });
      if (isOneBot11Success(response)) return { status: "succeeded", messageId };
      if (response.status === "failed")
        return {
          status: "failed",
          error: "OneBot 11 rejected message deletion.",
          platformReceipt: { ...(response.retcode === undefined ? {} : { code: response.retcode }) }
        };
      return { status: "uncertain", error: "Message deletion receipt was not confirmed." };
    } catch {
      return { status: "uncertain", error: "Message deletion receipt was not confirmed." };
    }
  }

  /** 查询平台消息并返回原生资源，查询目标定义会话归属而不是把机器人发送者当作私聊对端 */
  async getMessage(target: ChannelActionTarget, messageId: string, channelId: string): Promise<ChannelOperationResult> {
    if (target.type === "channel")
      return { status: "unsupported", error: "OneBot 11 does not support channel targets." };
    if (!messageId) return { status: "failed", error: "Message identifier is required." };
    try {
      const response = await this.connection.call("get_msg", { message_id: messageId });
      if (!isOneBot11Success(response))
        return {
          status: "failed",
          error: "OneBot 11 message query failed.",
          platformReceipt: { ...(response.retcode === undefined ? {} : { code: response.retcode }) }
        };
      if (!isRecord(response.data)) return { status: "failed", error: "Invalid OneBot 11 message resource." };
      if (
        response.data.message_type !== target.type ||
        (target.type === "group" && stringFromUnknown(response.data.group_id) !== target.groupId)
      )
        return { status: "failed", error: "OneBot 11 message does not belong to the requested conversation." };
      const payload = { ...response.data, post_type: response.data.post_type ?? "message" };
      const event = normalizeOneBot11Event(channelId, payload);
      if (event?.message === undefined) return { status: "failed", error: "Invalid OneBot 11 message resource." };
      return {
        status: "succeeded",
        messageId,
        data: {
          kind: "message",
          message: {
            id: messageId,
            conversation: {
              id: target.type === "group" ? target.groupId : target.userId,
              kind: target.type,
              platform: "qq",
              channelId
            },
            message: event.message,
            sender: event.sender,
            ...(event.origin === undefined ? {} : { origin: event.origin }),
            createdAt: event.receivedAt
          }
        }
      };
    } catch {
      return { status: "failed", error: "OneBot 11 message query failed." };
    }
  }
}
