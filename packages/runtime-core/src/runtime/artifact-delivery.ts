import type { RecoverToolOutputInput } from "../trace/types.js";
import { createHash } from "node:crypto";
import { executeChannelAction, type ChannelAdapter, type ChannelRegistry } from "@synapse/runtime-channel";
import { groupFileUploadAction, type ChannelOperationResult, type GroupFileUpload } from "@synapse/runtime-protocol";
import type { RuntimeCoreOptions } from "./types.js";
import type { MessageSegment } from "@synapse/runtime-protocol";
import type { ToolContext } from "@synapse/runtime-tool-runtime";

/** 上传归属来自可信请求与工件登记，不接受模型指定目标 */
export interface ArtifactDeliveryKey {
  readonly sessionId: string;
  readonly channelId: string;
  readonly groupId: string;
  readonly artifactId: string;
}

/** pending 只表示已获得上传占位，不能推断平台终态 */
export type ArtifactDeliveryRecord = ChannelOperationResult | { readonly status: "pending" };

/** 原子回执端口，具体持久介质与文件格式由宿主实现 */
export interface ArtifactDeliveryReceipts {
  /** 读取已确认结果或未决占位 */
  get(key: ArtifactDeliveryKey): ArtifactDeliveryRecord | undefined;
  /** 外部副作用前原子占位，失败表示已经存在上传意图 */
  claim(key: ArtifactDeliveryKey): boolean;
  /** 持久保存平台结果，失败时保留占位供恢复核对 */
  complete(key: ArtifactDeliveryKey, result: ChannelOperationResult): void;
}

/** 工件内容和选中状态由领域存储校验，Runtime 不读取具体文件 */
export interface ArtifactDeliveryReader {
  /** 校验会话归属并返回工件选择状态 */
  describe(sessionId: string, id: string): { readonly disposition?: "selected" | "candidate" | "discarded" };
  /** 校验内容完整性后返回交付所需的字节与元数据 */
  read(
    sessionId: string,
    id: string
  ): GroupFileUpload & { readonly id: string; readonly size: number; readonly sha256: string };
}

/** 固定字段顺序派生交付身份，沿用历史回执摘要算法以兼容重启恢复 */
export function artifactDeliveryIdentity(key: ArtifactDeliveryKey): string {
  return createHash("sha256")
    .update(JSON.stringify(deliveryKey(key)))
    .digest("hex");
}

function deliveryKey(key: ArtifactDeliveryKey): ArtifactDeliveryKey {
  return { sessionId: key.sessionId, channelId: key.channelId, groupId: key.groupId, artifactId: key.artifactId };
}

/** 未决占位只能转换为未知结果，禁止恢复和工具入口自动重放副作用 */
export function resolveArtifactReceipt(record: ArtifactDeliveryRecord | undefined): ChannelOperationResult | undefined {
  return record?.status === "pending"
    ? { status: "uncertain", error: "该工件已有未确认上传，请先核对群文件，当前未重复上传" }
    : record;
}

/** 工具与自动回复共用的交付状态机，已有任意终态均复用原回执 */
export async function deliverArtifact(
  receipts: ArtifactDeliveryReceipts,
  key: ArtifactDeliveryKey,
  upload: () => Promise<ChannelOperationResult>
): Promise<ChannelOperationResult> {
  key = deliveryKey(key);
  const existing = resolveArtifactReceipt(receipts.get(key));
  if (existing !== undefined) return existing;
  if (!receipts.claim(key)) return resolveArtifactReceipt({ status: "pending" })!;
  let result: ChannelOperationResult;
  try {
    result = await upload();
  } catch {
    result = { status: "uncertain", error: "群文件上传结果未知，当前未自动重试" };
  }
  receipts.complete(key, result);
  return result;
}

/** 按平台声明决定群文件功能是否可见，最终约束仍由统一动作执行器检查 */
export function canUploadGroupFile(adapter: ChannelAdapter | undefined): boolean {
  const capability = adapter?.getCapabilities().capabilities["file.upload"];
  return (
    (capability?.status === "supported" || capability?.status === "partially-supported") &&
    (capability.constraints?.targetTypes === undefined || capability.constraints.targetTypes.includes("group"))
  );
}

/** 目标只来自可信执行上下文，0.1 容器工件工具保持群聊边界 */
export function requireGroupArtifactDestination(
  channels: ChannelRegistry,
  context: Pick<ToolContext, "source">
): { adapter: ChannelAdapter; channelId: string; groupId: string } {
  if (context.source?.conversationKind !== "group") throw new Error("0.1 的容器工件能力仅向群聊开放");
  const adapter = channels.get(context.source.channelId);
  if (adapter === undefined || !canUploadGroupFile(adapter)) throw new Error("当前频道不支持群文件上传");
  return { adapter, channelId: context.source.channelId, groupId: context.source.conversationId };
}

/** 在统一动作边界内上传工件，幂等身份与调用编号、重启时间无关 */
export function deliverGroupArtifact(
  receipts: ArtifactDeliveryReceipts,
  adapter: ChannelAdapter,
  key: ArtifactDeliveryKey,
  file: GroupFileUpload
): Promise<ChannelOperationResult> {
  key = deliveryKey(key);
  const identity = `file.upload:${artifactDeliveryIdentity(key)}`;
  return deliverArtifact(receipts, key, async () => {
    const receipt = await executeChannelAction(
      adapter,
      groupFileUploadAction({
        actionId: identity,
        idempotencyKey: identity,
        channelId: key.channelId,
        conversation: { id: key.groupId, kind: "group" },
        target: { type: "group", groupId: key.groupId },
        file: { name: file.name, data: file.data }
      })
    );
    // 回执只包含平台事实，动作元数据和文件字节不进入模型、DAG 或恢复文件
    return receipt.status === "succeeded"
      ? { status: "succeeded", ...(receipt.fileId === undefined ? {} : { fileId: receipt.fileId }) }
      : { status: receipt.status, error: receipt.error };
  });
}

/** 上传前核对最终选择和会话归属，权限门控仍由 ToolRuntime 或 Delivery 执行 */
export async function uploadSelectedArtifact(
  artifacts: ArtifactDeliveryReader,
  receipts: ArtifactDeliveryReceipts,
  adapter: ChannelAdapter,
  key: ArtifactDeliveryKey,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (artifacts.describe(key.sessionId, key.artifactId).disposition !== "selected")
    throw new Error("工件未被选为最终产物，请先明确选择后再交付");
  const artifact = artifacts.read(key.sessionId, key.artifactId);
  signal?.throwIfAborted();
  const result = await deliverGroupArtifact(receipts, adapter, key, artifact);
  return { ...result, artifactId: key.artifactId, name: artifact.name, size: artifact.size, sha256: artifact.sha256 };
}

/** 群文件在持久交付边界内走统一动作入口，文本失败后仍保留每个已交付工件的事实 */
export function createArtifactDelivery(
  artifacts: Pick<ArtifactDeliveryReader, "read">,
  deliveries: ArtifactDeliveryReceipts,
  channels: ChannelRegistry
): NonNullable<RuntimeCoreOptions["prepareDelivery"]> {
  return async (input) => {
    if (input.conversationKind !== "group") return { status: "ready", message: input.message };
    const adapter = channels.get(input.channelId);
    const segments: MessageSegment[] = [];
    for (const part of input.message.segments) {
      if (part.type !== "file" || !part.url?.startsWith("artifact://")) {
        segments.push(part);
        continue;
      }
      if (adapter === undefined) return { status: "failed", error: "群文件目标频道不可用" };
      input.signal?.throwIfAborted();
      const artifactId = part.url.slice(11);
      const artifact = artifacts.read(input.sessionId, artifactId);
      input.observe("artifact_upload_started", { artifactId, automatic: true });
      // 保持原有附件顺序，逐个等待平台回执后再继续，禁止并行重复交付
      // eslint-disable-next-line no-await-in-loop
      const result = await deliverGroupArtifact(
        deliveries,
        adapter,
        { sessionId: input.sessionId, channelId: input.channelId, groupId: input.conversationId, artifactId },
        artifact
      );
      input.signal?.throwIfAborted();
      input.observe(
        result.status === "succeeded"
          ? "artifact_upload_succeeded"
          : result.status === "uncertain"
            ? "artifact_upload_uncertain"
            : "artifact_upload_failed",
        { artifactId, ...result, automatic: true }
      );
      if (result.status !== "succeeded")
        return { status: result.status === "uncertain" ? "uncertain" : "failed", error: result.error };
    }
    return { status: "ready", message: { ...input.message, segments } };
  };
}

/** 将已知工件回执映射为历史工具输出，不执行平台调用或推测上传成功 */
export function recoverArtifactToolOutput(
  receipts: ArtifactDeliveryReceipts,
  request: RecoverToolOutputInput
): Readonly<Record<string, unknown>> | undefined {
  if (request.name !== "artifact.upload" || request.conversationType !== "group") return undefined;
  const artifactId = (request.input as { artifactId?: unknown } | null)?.artifactId;
  if (typeof artifactId !== "string") return undefined;
  const receipt = resolveArtifactReceipt(
    receipts.get({
      sessionId: request.sessionId,
      channelId: request.channelId,
      groupId: request.conversationId,
      artifactId
    })
  );
  return receipt === undefined ? undefined : { ...receipt, artifactId };
}
