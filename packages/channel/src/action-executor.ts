import {
  CHANNEL_PROTOCOL_SCHEMA_VERSION,
  type ChannelActionResult,
  type ChannelCapabilityConstraints,
  type ChannelOperationResult,
  type ChannelOutputAction,
  type SynapseMessage
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
  if (action.schemaVersion !== CHANNEL_PROTOCOL_SCHEMA_VERSION) {
    return result({ status: "failed", error: "Unsupported channel protocol version." }, "CHANNEL_VERSION_MISMATCH");
  }
  const profile = adapter.getCapabilities();
  if (
    profile.schemaVersion !== CHANNEL_PROTOCOL_SCHEMA_VERSION ||
    profile.channelId !== adapter.id ||
    profile.adapterType !== adapter.type
  ) {
    return result(
      { status: "failed", error: "Channel capability profile does not belong to this adapter." },
      "CHANNEL_CAPABILITY_MISMATCH"
    );
  }
  const capability =
    profile.capabilities[action.actionType === "platform.execute" ? action.capability : action.actionType];
  if (capability?.status !== "supported" && capability?.status !== "partially-supported") return unsupported();
  const actionMessage =
    "message" in action
      ? action.message
      : action.actionType === "interaction.respond"
        ? action.response.message
        : undefined;
  const message =
    actionMessage === undefined
      ? undefined
      : {
          ...actionMessage,
          ...(actionMessage.replyTo !== undefined || action.replyTo === undefined ? {} : { replyTo: action.replyTo })
        };
  const constraints = [capability.constraints, capability.constraints?.perTarget?.[action.target.type]];
  for (const constraint of constraints) {
    if (!acceptsMessage(constraint, action.target.type, message)) return unsupported();
  }
  if (message?.segments.some((part) => ["image", "audio", "video"].includes(part.type))) {
    const media = profile.capabilities["message.media"];
    if (media?.status !== "supported" && media?.status !== "partially-supported") return unsupported();
    if (
      !acceptsMessage(media.constraints, action.target.type, message) ||
      !acceptsMessage(media.constraints?.perTarget?.[action.target.type], action.target.type, message)
    )
      return unsupported();
  }
  if (action.actionType === "file.upload") {
    if (
      adapter.executeAction === undefined &&
      (action.target.type !== "group" || adapter.uploadGroupFile === undefined)
    )
      return unsupported();
    if (
      constraints.some(
        (constraint) =>
          constraint?.maxFileSizeBytes !== undefined && action.file.data.byteLength > constraint.maxFileSizeBytes
      )
    ) {
      return result(
        { status: "failed", error: "File exceeds the declared channel size limit." },
        "CHANNEL_CONSTRAINT_VIOLATION"
      );
    }
  }
  if (action.actionType === "platform.execute" && adapter.executePlatformAction === undefined) return unsupported();
  if (
    action.actionType !== "message.send" &&
    action.actionType !== "file.upload" &&
    action.actionType !== "platform.execute" &&
    adapter.executeAction === undefined
  )
    return unsupported();
  try {
    let receipt: ChannelOperationResult;
    if (action.actionType === "platform.execute") receipt = await adapter.executePlatformAction!(action);
    else if (adapter.executeAction !== undefined)
      receipt = await adapter.executeAction("message" in action ? { ...action, message: message! } : action);
    else if (action.actionType === "message.send") receipt = await adapter.sendMessage(action.target, message!);
    else if (action.actionType === "file.upload" && action.target.type === "group")
      receipt = await adapter.uploadGroupFile!(action.target.groupId, action.file);
    else return unsupported();
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

function acceptsMessage(
  constraints: ChannelCapabilityConstraints | undefined,
  targetType: ChannelOutputAction["target"]["type"],
  message: SynapseMessage | undefined
): boolean {
  if (constraints === undefined) return true;
  if (constraints?.targetTypes !== undefined && !constraints.targetTypes.includes(targetType)) return false;
  if (message === undefined) return true;
  if (message.replyTo?.required && !acceptsReply(constraints, message.replyTo)) return false;
  if (
    message.components?.length &&
    constraints.messageComponents !== undefined &&
    message.components.some((part) => !constraints.messageComponents!.includes(part.type))
  )
    return false;
  return message.segments.every((part) => {
    if (constraints?.messageSegmentTypes !== undefined && !constraints.messageSegmentTypes.includes(part.type))
      return false;
    if (
      part.type === "rich-content" &&
      constraints?.richContentFormats !== undefined &&
      !constraints.richContentFormats.includes(part.format)
    )
      return false;
    if (
      part.type === "mention" &&
      constraints?.mentionTargets !== undefined &&
      !constraints.mentionTargets.includes(part.target ?? (part.userId === undefined ? "unknown" : "user"))
    )
      return false;
    if (part.type === "reply" && !acceptsReply(constraints, part)) return false;
    return true;
  });
}

function acceptsReply(
  constraints: ChannelCapabilityConstraints,
  reply: { readonly messageId?: string; readonly eventId?: string }
): boolean {
  if (constraints.replyContextKinds === undefined) return true;
  const kind = reply.messageId !== undefined ? "message" : reply.eventId === undefined ? undefined : "event";
  return kind === undefined || constraints.replyContextKinds.includes(kind);
}
