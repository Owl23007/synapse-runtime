import { createHash } from "node:crypto";
import { executeChannelAction, type ChannelAdapter } from "@synapse/runtime-channel";
import { groupFileUploadAction, type ChannelOperationResult, type GroupFileUpload } from "@synapse/runtime-protocol";
import type { ArtifactDeliveryKey, ArtifactDeliveryStore } from "./artifact-delivery.js";

/** 按当前平台声明决定群文件功能是否可用，最终约束与实现检查仍由统一执行器负责 */
export function canUploadGroupFile(adapter: ChannelAdapter | undefined): boolean {
  const capability = adapter?.getCapabilities().capabilities["file.upload"];
  return (
    (capability?.status === "supported" || capability?.status === "partially-supported") &&
    (capability.constraints?.targetTypes === undefined || capability.constraints.targetTypes.includes("group"))
  );
}

/** 在 Runtime 的持久交付边界内执行上传动作，工具和自动交付复用同一归属与幂等身份 */
export function deliverGroupArtifact(
  deliveries: ArtifactDeliveryStore,
  adapter: ChannelAdapter,
  key: ArtifactDeliveryKey,
  file: GroupFileUpload
): Promise<ChannelOperationResult> {
  // 固定键字段顺序，使工具调用和自动交付得到相同动作身份，且不依赖调用序号或重启时间
  const destination: ArtifactDeliveryKey = {
    sessionId: key.sessionId,
    channelId: key.channelId,
    groupId: key.groupId,
    artifactId: key.artifactId
  };
  const identity = `file.upload:${createHash("sha256").update(JSON.stringify(destination)).digest("hex")}`;
  return deliveries.deliver(destination, async () => {
    const receipt = await executeChannelAction(
      adapter,
      groupFileUploadAction({
        actionId: identity,
        idempotencyKey: identity,
        channelId: destination.channelId,
        conversation: { id: destination.groupId, kind: "group" },
        target: { type: "group", groupId: destination.groupId },
        file: { name: file.name, data: file.data }
      })
    );
    // 回执仓储只记录平台事实，动作元数据和文件字节不进入工具结果、DAG 或恢复文件
    return receipt.status === "succeeded"
      ? { status: "succeeded", ...(receipt.fileId === undefined ? {} : { fileId: receipt.fileId }) }
      : { status: receipt.status, error: receipt.error };
  });
}
