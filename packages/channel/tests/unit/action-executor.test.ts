import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_PROTOCOL_SCHEMA_VERSION,
  messageSendAction,
  textMessage,
  type ChannelCapability,
  type ChannelCapabilityKey,
  type ChannelCapabilityProfile,
  type ChannelOperationResult,
  type GroupFileUploadAction,
  type PlatformAction
} from "@synapse/runtime-protocol";
import { executeChannelAction } from "../../src/action-executor.js";
import type { ChannelAdapter } from "../../src/types.js";

function createActionExecutorFixture(capabilities: Partial<Record<ChannelCapabilityKey, ChannelCapability>> = {}) {
  const profile: ChannelCapabilityProfile = {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    channelId: "qq",
    adapterType: "test",
    observedAt: new Date(0).toISOString(),
    capabilities: { "message.send": { status: "supported" }, "file.upload": { status: "supported" }, ...capabilities }
  };
  const sendMessage = vi.fn<ChannelAdapter["sendMessage"]>(async () => ({ status: "succeeded", messageId: "m1" }));
  const uploadGroupFile = vi.fn<NonNullable<ChannelAdapter["uploadGroupFile"]>>(async () => ({
    status: "succeeded",
    fileId: "f1"
  }));
  const adapter: ChannelAdapter = {
    id: "qq",
    type: "test",
    provider: "test",
    async connect() {},
    async disconnect() {},
    onEvent() {},
    async getStatus() {
      return { state: "online", checkedAt: new Date(0).toISOString() };
    },
    getCapabilities() {
      return profile;
    },
    sendMessage,
    uploadGroupFile
  };
  const send = messageSendAction({
    actionId: "send",
    channelId: "qq",
    target: { type: "group", groupId: "123" },
    message: textMessage("hello")
  });
  const upload: GroupFileUploadAction = {
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    actionId: "upload",
    actionType: "file.upload",
    channelId: "qq",
    createdAt: new Date(0).toISOString(),
    target: { type: "group", groupId: "123" },
    file: { name: "a.txt", data: new Uint8Array([1, 2]) }
  };
  return { adapter, sendMessage, uploadGroupFile, send, upload, profile };
}

describe("统一 Channel 动作执行", () => {
  it("关联消息回执并保持消息与目标内容", async () => {
    const testContext = createActionExecutorFixture();
    expect(await executeChannelAction(testContext.adapter, testContext.send)).toMatchObject({
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
      actionId: "send",
      actionType: "message.send",
      status: "succeeded",
      messageId: "m1"
    });
    expect(testContext.sendMessage).toHaveBeenCalledWith(testContext.send.target, testContext.send.message);
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
  });

  it.each(["failed", "unsupported", "uncertain"] as const)("保留消息 %s 回执", async (status) => {
    const testContext = createActionExecutorFixture();
    testContext.sendMessage.mockResolvedValue({ status, error: "receipt" });
    expect(await executeChannelAction(testContext.adapter, testContext.send)).toMatchObject({
      status,
      error: "receipt",
      retryable: false
    });
  });

  it.each(["succeeded", "failed", "unsupported", "uncertain"] as const)("保留上传 %s 回执", async (status) => {
    const testContext = createActionExecutorFixture();
    const receipt: ChannelOperationResult =
      status === "succeeded" ? { status, fileId: "f2" } : { status, error: "receipt" };
    testContext.uploadGroupFile.mockResolvedValue(receipt);
    expect(await executeChannelAction(testContext.adapter, testContext.upload)).toMatchObject({
      ...receipt,
      actionId: "upload",
      actionType: "file.upload"
    });
    expect(testContext.uploadGroupFile).toHaveBeenCalledWith("123", testContext.upload.file);
    expect(testContext.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "unknown"] as const)("拒绝 %s 能力且不调用平台", async (status) => {
    const testContext = createActionExecutorFixture({ "message.send": { status }, "file.upload": { status } });
    expect((await executeChannelAction(testContext.adapter, testContext.send)).status).toBe("unsupported");
    expect((await executeChannelAction(testContext.adapter, testContext.upload)).status).toBe("unsupported");
    expect(testContext.sendMessage).not.toHaveBeenCalled();
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("未声明能力或缺少上传实现时明确拒绝", async () => {
    const testContext = createActionExecutorFixture();
    expect(
      (
        await executeChannelAction(
          { ...testContext.adapter, getCapabilities: () => ({ ...testContext.profile, capabilities: {} }) },
          testContext.send
        )
      ).status
    ).toBe("unsupported");
    const { uploadGroupFile: _, ...adapter } = testContext.adapter;
    expect((await executeChannelAction(adapter, testContext.upload)).status).toBe("unsupported");
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("拒绝跨频道动作和错误归属的能力档案", async () => {
    const testContext = createActionExecutorFixture();
    expect(await executeChannelAction(testContext.adapter, { ...testContext.send, channelId: "other" })).toMatchObject({
      status: "failed",
      errorCode: "CHANNEL_ID_MISMATCH"
    });
    expect(
      await executeChannelAction(
        { ...testContext.adapter, getCapabilities: () => ({ ...testContext.profile, channelId: "other" }) },
        testContext.send
      )
    ).toMatchObject({ status: "failed", errorCode: "CHANNEL_CAPABILITY_MISMATCH" });
    expect(testContext.sendMessage).not.toHaveBeenCalled();
  });

  it("部分支持按目标和文件大小约束执行", async () => {
    const testContext = createActionExecutorFixture({
      "file.upload": { status: "partially-supported", constraints: { targetTypes: ["group"], maxFileSizeBytes: 1 } }
    });
    expect(await executeChannelAction(testContext.adapter, testContext.upload)).toMatchObject({
      status: "failed",
      errorCode: "CHANNEL_CONSTRAINT_VIOLATION"
    });
    expect(testContext.uploadGroupFile).not.toHaveBeenCalled();
    expect(
      (
        await executeChannelAction(testContext.adapter, {
          ...testContext.upload,
          file: { name: "small", data: new Uint8Array([1]) }
        })
      ).status
    ).toBe("succeeded");
  });

  it("在目标和媒体约束不满足时停止发送", async () => {
    const testContext = createActionExecutorFixture({
      "message.send": { status: "partially-supported", constraints: { targetTypes: ["private"] } }
    });
    expect((await executeChannelAction(testContext.adapter, testContext.send)).status).toBe("unsupported");
    const media = createActionExecutorFixture();
    expect(
      (
        await executeChannelAction(media.adapter, {
          ...media.send,
          message: { type: "image", segments: [{ type: "image", url: "https://example.test/a.png" }] }
        })
      ).status
    ).toBe("unsupported");
    expect(testContext.sendMessage).not.toHaveBeenCalled();
    expect(media.sendMessage).not.toHaveBeenCalled();
  });

  it("拒绝未实现的消息片段而不静默丢弃", async () => {
    const testContext = createActionExecutorFixture({
      "message.send": { status: "partially-supported", constraints: { messageSegmentTypes: ["text"] } },
      "message.media": { status: "supported" }
    });
    expect(
      (
        await executeChannelAction(testContext.adapter, {
          ...testContext.send,
          message: {
            type: "mixed",
            segments: [
              { type: "text", text: "hello" },
              { type: "audio", url: "https://example.test/a.ogg" }
            ]
          }
        })
      ).status
    ).toBe("unsupported");
    expect(testContext.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["send", "upload"] as const)("%s 异常转为不可自动重试的未知结果且不泄露内容", async (kind) => {
    const testContext = createActionExecutorFixture();
    (kind === "send" ? testContext.sendMessage : testContext.uploadGroupFile).mockRejectedValue(
      new Error("private payload")
    );
    const result = await executeChannelAction(
      testContext.adapter,
      kind === "send" ? testContext.send : testContext.upload
    );
    expect(result).toMatchObject({ status: "uncertain", retryable: false, errorCode: "CHANNEL_ACTION_UNCERTAIN" });
    expect(JSON.stringify(result)).not.toContain("private payload");
  });

  it("即使声明支持也拒绝尚未实现的标准动作", async () => {
    const testContext = createActionExecutorFixture({ "message.delete": { status: "supported" } });
    const { message: _, ...base } = testContext.send;
    expect(
      (
        await executeChannelAction(testContext.adapter, {
          ...base,
          actionType: "message.delete",
          targetMessageId: "m1"
        })
      ).status
    ).toBe("unsupported");
    expect(testContext.sendMessage).not.toHaveBeenCalled();
  });

  it("平台扩展必须匹配独立命名空间、能力与实现", async () => {
    const testContext = createActionExecutorFixture({ "napcat:test": { status: "supported" } });
    const action: PlatformAction = {
      ...testContext.upload,
      actionType: "platform.execute",
      capability: "napcat:test",
      params: { value: 1 }
    };
    expect((await executeChannelAction(testContext.adapter, action)).status).toBe("unsupported");
    const executePlatformAction = vi.fn<NonNullable<ChannelAdapter["executePlatformAction"]>>(async () => ({
      status: "succeeded"
    }));
    const adapter = { ...testContext.adapter, executePlatformAction };
    expect((await executeChannelAction(adapter, { ...action, capability: "onebot11:test" })).status).toBe(
      "unsupported"
    );
    expect(executePlatformAction).not.toHaveBeenCalled();
    expect((await executeChannelAction(adapter, action)).status).toBe("succeeded");
    expect(executePlatformAction).toHaveBeenCalledWith(action);
  });
});
