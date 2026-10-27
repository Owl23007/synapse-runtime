import {
  CHANNEL_PROTOCOL_SCHEMA_VERSION,
  type ChannelActionResult,
  type ChannelOperationResult,
  type ChannelOutputAction
} from "@synapse/runtime-protocol";
import type { ChannelAdapter } from "./types.js";

/** 执行平台动作并统一回执，权限、幂等、持久化与恢复由 Runtime 管理
 *
 * 未声明或未接入实现的能力明确拒绝，传输异常保留 uncertain，不能据此自动重试
 */
export async function executeChannelAction(
  adapter: ChannelAdapter,
  action: ChannelOutputAction
): Promise<ChannelActionResult> {
  const result = (receipt: ChannelOperationResult, errorCode?: string): ChannelActionResult => ({
    ...receipt,
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionId: action.actionId,
    actionType: action.actionType,
    executedAt: new Date().toISOString(),
    ...(receipt.status === "succeeded" ? {} : { retryable: false }),
    ...(errorCode === undefined ? {} : { errorCode })
  });
  const unsupported = () =>
    result(
      {
        status: "unsupported",
        error: `Channel adapter "${adapter.type}" does not support ${action.actionType} for this target.`
      },
      "CHANNEL_ACTION_UNSUPPORTED"
    );
  if (action.channelId !== adapter.id) {
    return result({ status: "failed", error: "Channel action targets a different adapter." }, "CHANNEL_ID_MISMATCH");
  }
  // 能力声明不等于已经实现，未接入执行器的动作仍须明确拒绝
  if (
    action.actionType !== "message.send" &&
    action.actionType !== "file.upload" &&
    action.actionType !== "platform.execute"
  )
    return unsupported();
  const profile = adapter.getCapabilities();
  if (profile.channelId !== adapter.id || profile.adapterType !== adapter.type) {
    return result(
      { status: "failed", error: "Channel capability profile does not belong to this adapter." },
      "CHANNEL_CAPABILITY_MISMATCH"
    );
  }
  const capability =
    profile.capabilities[action.actionType === "platform.execute" ? action.capability : action.actionType];
  if (capability?.status !== "supported" && capability?.status !== "partially-supported") return unsupported();
  const constraints = capability.constraints;
  if (constraints?.targetTypes !== undefined && !constraints.targetTypes.includes(action.target.type))
    return unsupported();
  if (action.actionType === "message.send" && constraints?.messageSegmentTypes !== undefined) {
    const supportedSegments = constraints.messageSegmentTypes;
    if (action.message.segments.some((part) => !supportedSegments.includes(part.type))) return unsupported();
  }
  if (
    action.actionType === "message.send" &&
    action.message.segments.some((part) => ["image", "audio", "video"].includes(part.type))
  ) {
    const media = profile.capabilities["message.media"];
    if (media?.status !== "supported" && media?.status !== "partially-supported") return unsupported();
    if (media.constraints?.targetTypes !== undefined && !media.constraints.targetTypes.includes(action.target.type))
      return unsupported();
  }
  if (action.actionType === "file.upload") {
    if (adapter.uploadGroupFile === undefined) return unsupported();
    if (constraints?.maxFileSizeBytes !== undefined && action.file.data.byteLength > constraints.maxFileSizeBytes) {
      return result(
        { status: "failed", error: "File exceeds the declared channel size limit." },
        "CHANNEL_CONSTRAINT_VIOLATION"
      );
    }
  }
  if (action.actionType === "platform.execute" && adapter.executePlatformAction === undefined) return unsupported();
  try {
    const receipt =
      action.actionType === "message.send"
        ? await adapter.sendMessage(action.target, action.message)
        : action.actionType === "file.upload"
          ? await adapter.uploadGroupFile!(action.target.groupId, action.file)
          : await adapter.executePlatformAction!(action);
    return result(
      receipt,
      receipt.status === "succeeded" ? undefined : `CHANNEL_ACTION_${receipt.status.toUpperCase()}`
    );
  } catch {
    // 异常不能证明平台没有执行，外部错误还可能携带消息或文件内容
    return result(
      {
        status: "uncertain",
        error: "Channel action receipt was not confirmed; verify platform delivery before retrying."
      },
      "CHANNEL_ACTION_UNCERTAIN"
    );
  }
}
