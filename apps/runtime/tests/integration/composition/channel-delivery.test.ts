import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it, vi } from "vitest";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import type { ChannelCapability, ChannelOperationResult } from "@synapse/runtime-protocol";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import { ContainerSettingsSchema } from "@synapse/runtime-tool-container/config";
import { ArtifactDeliveryStore, inspectArtifactDelivery } from "../../../src/composition/artifact-delivery.js";
import { canUploadGroupFile, deliverGroupArtifact } from "../../../src/composition/channel-delivery.js";
import { createArtifactDelivery } from "../../../src/composition/docker-artifacts.js";

function createChannelDeliveryFixture(
  capability: ChannelCapability = { status: "supported", constraints: { targetTypes: ["group"] } }
) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-channel-delivery-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
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
    const testContext = createChannelDeliveryFixture();
    let confirm!: (result: ChannelOperationResult) => void;
    testContext.uploadGroupFile.mockImplementation(
      () =>
        new Promise((resolveReceipt) => {
          confirm = resolveReceipt;
        })
    );
    const first = deliverGroupArtifact(testContext.deliveries, testContext.adapter, testContext.key, testContext.file);
    expect(
      await deliverGroupArtifact(testContext.deliveries, testContext.adapter, testContext.key, testContext.file)
    ).toMatchObject({ status: "uncertain" });
    confirm({ status: "succeeded", fileId: "platform-file" });
    expect(await first).toEqual({ status: "succeeded", fileId: "platform-file" });
    const restarted = new ArtifactDeliveryStore(testContext.directory);
    expect(await deliverGroupArtifact(restarted, testContext.adapter, testContext.key, testContext.file)).toEqual({
      status: "succeeded",
      fileId: "platform-file"
    });
    expect(testContext.uploadGroupFile).toHaveBeenCalledTimes(1);
    expect(testContext.uploadGroupFile).toHaveBeenCalledWith("123", testContext.file);
    const receipts = readdirSync(testContext.directory).filter((path) => path.endsWith(".json"));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(testContext.directory, receipts[0]!), "utf8"))).toEqual({
      status: "succeeded",
      fileId: "platform-file"
    });
  });

  it.each(["failed", "unsupported", "uncertain"] as const)("%s 回执跨重启保留且不重新执行", async (status) => {
    const testContext = createChannelDeliveryFixture();
    testContext.uploadGroupFile.mockResolvedValue({ status, error: "platform receipt" });
    expect(
      await deliverGroupArtifact(testContext.deliveries, testContext.adapter, testContext.key, testContext.file)
    ).toEqual({
      status,
      error: "platform receipt"
    });
    expect(
      await deliverGroupArtifact(
        new ArtifactDeliveryStore(testContext.directory),
        testContext.adapter,
        testContext.key,
        testContext.file
      )
    ).toEqual({
      status,
      error: "platform receipt"
    });
    expect(testContext.uploadGroupFile).toHaveBeenCalledTimes(1);
  });

  it("能力大小约束在平台调用前拒绝，不能绕过统一执行器", async () => {
    const testContext = createChannelDeliveryFixture({
      status: "partially-supported",
      constraints: { targetTypes: ["group"], maxFileSizeBytes: 1 }
    });
    expect(canUploadGroupFile(testContext.adapter)).toBe(true);
    expect(
      (await deliverGroupArtifact(testContext.deliveries, testContext.adapter, testContext.key, testContext.file))
        .status
    ).toBe("failed");
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("能力可见性按目标约束判断，未知与非群目标不开放群文件工具", () => {
    const privateOnly = createChannelDeliveryFixture({
      status: "partially-supported",
      constraints: { targetTypes: ["private"] }
    });
    expect(canUploadGroupFile(privateOnly.adapter)).toBe(false);
    expect(canUploadGroupFile(createChannelDeliveryFixture({ status: "unknown" }).adapter)).toBe(false);
    expect(canUploadGroupFile(undefined)).toBe(false);
  });

  it("错误频道不能执行上传，已确认回执也不能被其他群或会话复用", async () => {
    const testContext = createChannelDeliveryFixture();
    expect(
      (
        await deliverGroupArtifact(
          testContext.deliveries,
          testContext.adapter,
          { ...testContext.key, channelId: "other" },
          testContext.file
        )
      ).status
    ).toBe("failed");
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
    await deliverGroupArtifact(testContext.deliveries, testContext.adapter, testContext.key, testContext.file);
    expect(inspectArtifactDelivery(testContext.directory, { ...testContext.key, groupId: "456" })).toBeUndefined();
    expect(
      inspectArtifactDelivery(testContext.directory, { ...testContext.key, sessionId: "other-session" })
    ).toBeUndefined();
    expect(testContext.uploadGroupFile).toHaveBeenCalledTimes(1);
  });

  it.each(["unsupported", "missing-method", "size-limit"])(
    "自动交付遇到 %s 必须失败，不能把附件转入普通消息绕过能力检查",
    async (mode) => {
      const testContext = createChannelDeliveryFixture(
        mode === "unsupported"
          ? { status: "unsupported" }
          : {
              status: "partially-supported",
              constraints: { targetTypes: ["group"], maxFileSizeBytes: mode === "size-limit" ? 1 : 1000 }
            }
      );
      const artifacts = new ArtifactStore(join(testContext.directory, "artifacts"), ContainerSettingsSchema.parse({}));
      const [artifact] = artifacts.save({ sessionId: "session", runId: "run", callId: "call" }, [testContext.file]);
      const channels = new InMemoryChannelRegistry();
      const { uploadGroupFile: _, ...withoutUpload } = testContext.adapter;
      channels.register(mode === "missing-method" ? withoutUpload : testContext.adapter);
      const prepare = createArtifactDelivery(artifacts, testContext.deliveries, channels);
      const observe = vi.fn<(type: string, data: unknown) => void>();
      const result = await prepare({
        sessionId: "session",
        channelId: "qq",
        conversationId: "123",
        conversationKind: "group",
        message: {
          type: "file",
          segments: [{ type: "file", name: testContext.file.name, url: `artifact://${artifact!.id}` }]
        },
        observe
      });
      expect(result.status).toBe("failed");
      expect(observe).toHaveBeenCalledWith(
        "artifact_upload_failed",
        expect.objectContaining({ artifactId: artifact!.id })
      );
      expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
    }
  );
});
