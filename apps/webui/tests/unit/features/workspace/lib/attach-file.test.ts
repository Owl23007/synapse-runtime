import { describe, expect, it, vi } from "vitest";
import type { AssetInfo, AssetVersionInfo, RuntimeAdminClient } from "@synapse/runtime-client";
import { attachWorkspaceFile } from "../../../../../src/features/workspace/lib/attach-file.js";

const asset: AssetInfo = {
  id: "source-file",
  workspaceId: "source-workspace",
  displayName: "report.txt",
  declaredMime: "text/plain",
  declaredSizeBytes: 7,
  currentVersionId: "source-version",
  fetchState: "cached",
  fetchError: null,
  createdAt: "2026-11-04T00:00:00Z",
  updatedAt: "2026-11-04T00:00:00Z",
  deletedAt: null
};
const version: AssetVersionInfo = {
  id: "fetched-version",
  assetId: asset.id,
  versionNo: 1,
  sha256: "hash",
  sizeBytes: 7,
  detectedMime: "text/plain",
  createdAt: asset.createdAt
};

function client() {
  return {
    materializeAsset: vi.fn<RuntimeAdminClient["materializeAsset"]>().mockResolvedValue({ version }),
    downloadAsset: vi
      .fn<RuntimeAdminClient["downloadAsset"]>()
      .mockResolvedValue(new Blob(["content"], { type: "text/plain" })),
    uploadAsset: vi.fn<RuntimeAdminClient["uploadAsset"]>().mockResolvedValue({
      asset: { ...asset, id: "copied-file", workspaceId: "target-workspace" },
      version: { ...version, id: "copied-version", assetId: "copied-file" }
    })
  };
}

describe("工作区文件附加", () => {
  it("当前工作区直接附加选中的版本，不下载或重新上传", async () => {
    const api = client();
    await expect(attachWorkspaceFile(api, asset.workspaceId, asset, "key")).resolves.toEqual({
      assetId: asset.id,
      versionId: "source-version",
      name: "report.txt"
    });
    expect(api.materializeAsset).not.toHaveBeenCalled();
    expect(api.downloadAsset).not.toHaveBeenCalled();
    expect(api.uploadAsset).not.toHaveBeenCalled();
  });

  it("仅在选择尚未获取的文件时获取内容，并固定返回版本", async () => {
    const api = client();
    await expect(
      attachWorkspaceFile(api, asset.workspaceId, { ...asset, currentVersionId: null }, "key")
    ).resolves.toMatchObject({ assetId: asset.id, versionId: version.id });
    expect(api.materializeAsset).toHaveBeenCalledWith(asset.id);
    expect(api.uploadAsset).not.toHaveBeenCalled();
  });

  it("跨工作区按指定版本复制内容，附件引用目标副本而不是来源文件", async () => {
    const api = client();
    await expect(attachWorkspaceFile(api, "target-workspace", asset, "stable-copy-key")).resolves.toEqual({
      assetId: "copied-file",
      versionId: "copied-version",
      name: "report.txt"
    });
    expect(api.downloadAsset).toHaveBeenCalledWith("source-file", "source-version");
    const [target, file, key] = api.uploadAsset.mock.calls[0]!;
    expect(target).toBe("target-workspace");
    expect(file.name).toBe("report.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("content");
    expect(key).toBe("stable-copy-key");
    expect(asset.workspaceId).toBe("source-workspace");
  });

  it("跨工作区获取远端文件后仍下载固定版本，重试沿用上传幂等键", async () => {
    const api = client();
    const remote = { ...asset, currentVersionId: null };
    await attachWorkspaceFile(api, "target-workspace", remote, "retry-key");
    await attachWorkspaceFile(api, "target-workspace", remote, "retry-key");
    expect(api.downloadAsset).toHaveBeenCalledWith(asset.id, version.id);
    expect(api.uploadAsset.mock.calls.map((call) => call[2])).toEqual(["retry-key", "retry-key"]);
  });

  it("来源内容读取失败时不上传到目标工作区", async () => {
    const api = client();
    api.downloadAsset.mockRejectedValue(new Error("source unavailable"));
    await expect(attachWorkspaceFile(api, "target-workspace", asset, "key")).rejects.toThrow("source unavailable");
    expect(api.uploadAsset).not.toHaveBeenCalled();
  });
});
