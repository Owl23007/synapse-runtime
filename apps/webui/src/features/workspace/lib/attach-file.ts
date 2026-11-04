import type { AssetAttachmentInfo, AssetInfo, RuntimeAdminClient } from "@synapse/runtime-client";

/** 当前工作区直接固定版本，跨工作区显式复制后附加，保持会话的文件作用域 */
export async function attachWorkspaceFile(
  client: Pick<RuntimeAdminClient, "materializeAsset" | "downloadAsset" | "uploadAsset">,
  workspaceId: string,
  asset: AssetInfo,
  idempotencyKey: string
): Promise<AssetAttachmentInfo> {
  const versionId = asset.currentVersionId ?? (await client.materializeAsset(asset.id)).version.id;
  if (asset.workspaceId === workspaceId) return { assetId: asset.id, versionId, name: asset.displayName };
  const content = await client.downloadAsset(asset.id, versionId);
  const file = new File([content], asset.displayName, {
    type: content.type || asset.declaredMime || "application/octet-stream"
  });
  const copied = await client.uploadAsset(workspaceId, file, idempotencyKey);
  return { assetId: copied.asset.id, versionId: copied.version.id, name: copied.asset.displayName };
}
