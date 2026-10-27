import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import type { ChannelCapability, ChannelOperationResult } from "@synapse/runtime-protocol";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import { ContainerSettingsSchema } from "@synapse/runtime-tool-container/config";
import { ArtifactDeliveryStore, inspectArtifactDelivery } from "./artifact-delivery.js";
import { canUploadGroupFile, deliverGroupArtifact } from "./channel-delivery.js";
import { createArtifactDelivery } from "./docker-artifacts.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(capability: ChannelCapability = { status: "supported", constraints: { targetTypes: ["group"] } }) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-channel-delivery-"));
  directories.push(directory);
  const uploadGroupFile = vi
    .fn<NonNullable<ChannelAdapter["uploadGroupFile"]>>()
    .mockResolvedValue({ status: "succeeded", fileId: "platform-file" });
  const adapter: ChannelAdapter = {
    id: "qq",
    type: "test",
    provider: "test",
    async connect() {},
    async disconnect() {},
    onEvent() {},
    async getStatus() {
      return { state: "online", checkedAt: "" };
    },
    getCapabilities() {
      return {
        schemaVersion: "channel-protocol/v1",
        channelId: "qq",
        adapterType: "test",
        observedAt: "",
        capabilities: { "file.upload": capability }
      };
    },
    async sendMessage() {
      throw new Error("upload must not fall back to message sending");
    },
    uploadGroupFile
  };
  const key = { sessionId: "session", channelId: "qq", groupId: "123", artifactId: "artifact" };
  const file = { name: "a.txt", data: Buffer.from("private-artifact-contents") };
  return { directory, adapter, uploadGroupFile, key, file, deliveries: new ArtifactDeliveryStore(directory) };
}

describe("Runtime 统一群文件动作边界", () => {
  it("进行中不重复上传，成功回执跨入口与重启复用且不包含动作元数据或字节", async () => {
    const f = fixture();
    let confirm!: (result: ChannelOperationResult) => void;
    f.uploadGroupFile.mockImplementation(
      () =>
        new Promise((resolveReceipt) => {
          confirm = resolveReceipt;
        })
    );
    const first = deliverGroupArtifact(f.deliveries, f.adapter, f.key, f.file);
    expect(await deliverGroupArtifact(f.deliveries, f.adapter, f.key, f.file)).toMatchObject({ status: "uncertain" });
    confirm({ status: "succeeded", fileId: "platform-file" });
    expect(await first).toEqual({ status: "succeeded", fileId: "platform-file" });
    const restarted = new ArtifactDeliveryStore(f.directory);
    expect(await deliverGroupArtifact(restarted, f.adapter, f.key, f.file)).toEqual({
      status: "succeeded",
      fileId: "platform-file"
    });
    expect(f.uploadGroupFile).toHaveBeenCalledTimes(1);
    expect(f.uploadGroupFile).toHaveBeenCalledWith("123", f.file);
    const receipts = readdirSync(f.directory).filter((path) => path.endsWith(".json"));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.directory, receipts[0]!), "utf8"))).toEqual({
      status: "succeeded",
      fileId: "platform-file"
    });
  });

  it.each(["failed", "unsupported", "uncertain"] as const)("%s 回执跨重启保留且不重新执行", async (status) => {
    const f = fixture();
    f.uploadGroupFile.mockResolvedValue({ status, error: "platform receipt" });
    expect(await deliverGroupArtifact(f.deliveries, f.adapter, f.key, f.file)).toEqual({
      status,
      error: "platform receipt"
    });
    expect(await deliverGroupArtifact(new ArtifactDeliveryStore(f.directory), f.adapter, f.key, f.file)).toEqual({
      status,
      error: "platform receipt"
    });
    expect(f.uploadGroupFile).toHaveBeenCalledTimes(1);
  });

  it("能力大小约束在平台调用前拒绝，不能绕过统一执行器", async () => {
    const f = fixture({ status: "partially-supported", constraints: { targetTypes: ["group"], maxFileSizeBytes: 1 } });
    expect(canUploadGroupFile(f.adapter)).toBe(true);
    expect((await deliverGroupArtifact(f.deliveries, f.adapter, f.key, f.file)).status).toBe("failed");
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("能力可见性按目标约束判断，未知与非群目标不开放群文件工具", () => {
    const privateOnly = fixture({ status: "partially-supported", constraints: { targetTypes: ["private"] } });
    expect(canUploadGroupFile(privateOnly.adapter)).toBe(false);
    expect(canUploadGroupFile(fixture({ status: "unknown" }).adapter)).toBe(false);
    expect(canUploadGroupFile(undefined)).toBe(false);
  });

  it("错误频道不能执行上传，已确认回执也不能被其他群或会话复用", async () => {
    const f = fixture();
    expect((await deliverGroupArtifact(f.deliveries, f.adapter, { ...f.key, channelId: "other" }, f.file)).status).toBe(
      "failed"
    );
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
    await deliverGroupArtifact(f.deliveries, f.adapter, f.key, f.file);
    expect(inspectArtifactDelivery(f.directory, { ...f.key, groupId: "456" })).toBeUndefined();
    expect(inspectArtifactDelivery(f.directory, { ...f.key, sessionId: "other-session" })).toBeUndefined();
    expect(f.uploadGroupFile).toHaveBeenCalledTimes(1);
  });

  it.each(["unsupported", "missing-method", "size-limit"])(
    "自动交付遇到 %s 必须失败，不能把附件转入普通消息绕过能力检查",
    async (mode) => {
      const f = fixture(
        mode === "unsupported"
          ? { status: "unsupported" }
          : {
              status: "partially-supported",
              constraints: { targetTypes: ["group"], maxFileSizeBytes: mode === "size-limit" ? 1 : 1000 }
            }
      );
      const artifacts = new ArtifactStore(join(f.directory, "artifacts"), ContainerSettingsSchema.parse({}));
      const [artifact] = artifacts.save({ sessionId: "session", runId: "run", callId: "call" }, [f.file]);
      const channels = new InMemoryChannelRegistry();
      const { uploadGroupFile: _, ...withoutUpload } = f.adapter;
      channels.register(mode === "missing-method" ? withoutUpload : f.adapter);
      const prepare = createArtifactDelivery(artifacts, f.deliveries, channels);
      const observe = vi.fn<(type: string, data: unknown) => void>();
      const result = await prepare({
        sessionId: "session",
        channelId: "qq",
        conversationId: "123",
        conversationKind: "group",
        message: { type: "file", segments: [{ type: "file", name: f.file.name, url: `artifact://${artifact!.id}` }] },
        observe
      });
      expect(result.status).toBe("failed");
      expect(observe).toHaveBeenCalledWith(
        "artifact_upload_failed",
        expect.objectContaining({ artifactId: artifact!.id })
      );
      expect(f.uploadGroupFile).not.toHaveBeenCalled();
    }
  );
});
