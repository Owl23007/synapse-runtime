import type {
  ChannelActionTarget,
  ChannelOperationResult,
  MessageSegment,
  SynapseMessage
} from "@synapse/runtime-protocol";
import { isOneBot11Success } from "./codec.js";
import { createOneBot11SendParams } from "./message.js";
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
        return { status: "succeeded", ...(messageId === undefined ? {} : { messageId }) };
      }
      if (response.status === "failed") {
        return {
          status: "failed",
          error: `OneBot 11 send_msg failed: ${response.message ?? response.wording ?? "Message rejected"}`
        };
      }
      return { status: "uncertain", error: "消息发送未获得明确终态，请核对后再决定是否重新发送" };
    } catch {
      return { status: "uncertain", error: "消息发送回执未确认，请核对后再决定是否重新发送" };
    }
  }
}
