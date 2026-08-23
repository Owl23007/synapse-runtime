import type { ChannelActionResult, ChannelOutputAction } from "@synapse/runtime-protocol";
import { CHANNEL_PROTOCOL_SCHEMA_VERSION } from "@synapse/runtime-protocol";
import type { ChannelAdapter, ChannelTarget } from "./types.js";

/** 将统一出站动作交给 Channel Adapter 执行并转换为标准结果
 *
 * 当前 Adapter 已稳定支持 message.send，其他动作先返回明确的
 * unsupported 结果，避免把未实现能力静默降级为文本发送
 */
export async function executeChannelAction(
  adapter: ChannelAdapter,
  action: ChannelOutputAction
): Promise<ChannelActionResult> {
  if (action.actionType !== "message.send") {
    return {
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
      actionId: action.actionId,
      actionType: action.actionType,
      status: "unsupported",
      executedAt: new Date().toISOString(),
      errorCode: "CHANNEL_ACTION_UNSUPPORTED",
      errorMessage: `Channel adapter "${adapter.type}" does not support ${action.actionType}.`,
      retryable: false
    };
  }

  const result = await adapter.sendMessage(action.target as ChannelTarget, action.message);
  if (!result.ok) {
    return {
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
      actionId: action.actionId,
      actionType: action.actionType,
      status: "failed",
      executedAt: new Date().toISOString(),
      errorCode: "CHANNEL_SEND_FAILED",
      ...(result.error === undefined ? {} : { errorMessage: result.error }),
      retryable: false
    };
  }

  return {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionId: action.actionId,
    actionType: action.actionType,
    status: "succeeded",
    ...(result.messageId === undefined ? {} : { externalMessageId: result.messageId }),
    executedAt: new Date().toISOString()
  };
}
