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
import { executeChannelAction } from "./action-executor.js";
import type { ChannelAdapter } from "./types.js";

function fixture(capabilities: Partial<Record<ChannelCapabilityKey, ChannelCapability>> = {}) {
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
    const f = fixture();
    expect(await executeChannelAction(f.adapter, f.send)).toMatchObject({
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
      actionId: "send",
      actionType: "message.send",
      status: "succeeded",
      messageId: "m1"
    });
    expect(f.sendMessage).toHaveBeenCalledWith(f.send.target, f.send.message);
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
  });

  it.each(["failed", "unsupported", "uncertain"] as const)("保留消息 %s 回执", async (status) => {
    const f = fixture();
    f.sendMessage.mockResolvedValue({ status, error: "receipt" });
    expect(await executeChannelAction(f.adapter, f.send)).toMatchObject({ status, error: "receipt", retryable: false });
  });

  it.each(["succeeded", "failed", "unsupported", "uncertain"] as const)("保留上传 %s 回执", async (status) => {
    const f = fixture();
    const receipt: ChannelOperationResult =
      status === "succeeded" ? { status, fileId: "f2" } : { status, error: "receipt" };
    f.uploadGroupFile.mockResolvedValue(receipt);
    expect(await executeChannelAction(f.adapter, f.upload)).toMatchObject({
      ...receipt,
      actionId: "upload",
      actionType: "file.upload"
    });
    expect(f.uploadGroupFile).toHaveBeenCalledWith("123", f.upload.file);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "unknown"] as const)("拒绝 %s 能力且不调用平台", async (status) => {
    const f = fixture({ "message.send": { status }, "file.upload": { status } });
    expect((await executeChannelAction(f.adapter, f.send)).status).toBe("unsupported");
    expect((await executeChannelAction(f.adapter, f.upload)).status).toBe("unsupported");
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("未声明能力或缺少上传实现时明确拒绝", async () => {
    const f = fixture();
    expect(
      (
        await executeChannelAction(
          { ...f.adapter, getCapabilities: () => ({ ...f.profile, capabilities: {} }) },
          f.send
        )
      ).status
    ).toBe("unsupported");
    const { uploadGroupFile: _, ...adapter } = f.adapter;
    expect((await executeChannelAction(adapter, f.upload)).status).toBe("unsupported");
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
  });

  it("拒绝跨频道动作和错误归属的能力档案", async () => {
    const f = fixture();
    expect(await executeChannelAction(f.adapter, { ...f.send, channelId: "other" })).toMatchObject({
      status: "failed",
      errorCode: "CHANNEL_ID_MISMATCH"
    });
    expect(
      await executeChannelAction(
        { ...f.adapter, getCapabilities: () => ({ ...f.profile, channelId: "other" }) },
        f.send
      )
    ).toMatchObject({ status: "failed", errorCode: "CHANNEL_CAPABILITY_MISMATCH" });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("部分支持按目标和文件大小约束执行", async () => {
    const f = fixture({
      "file.upload": { status: "partially-supported", constraints: { targetTypes: ["group"], maxFileSizeBytes: 1 } }
    });
    expect(await executeChannelAction(f.adapter, f.upload)).toMatchObject({
      status: "failed",
      errorCode: "CHANNEL_CONSTRAINT_VIOLATION"
    });
    expect(f.uploadGroupFile).not.toHaveBeenCalled();
    expect(
      (await executeChannelAction(f.adapter, { ...f.upload, file: { name: "small", data: new Uint8Array([1]) } }))
        .status
    ).toBe("succeeded");
  });

  it("在目标和媒体约束不满足时停止发送", async () => {
    const f = fixture({ "message.send": { status: "partially-supported", constraints: { targetTypes: ["private"] } } });
    expect((await executeChannelAction(f.adapter, f.send)).status).toBe("unsupported");
    const media = fixture();
    expect(
      (
        await executeChannelAction(media.adapter, {
          ...media.send,
          message: { type: "image", segments: [{ type: "image", url: "https://example.test/a.png" }] }
        })
      ).status
    ).toBe("unsupported");
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(media.sendMessage).not.toHaveBeenCalled();
  });

  it("拒绝未实现的消息片段而不静默丢弃", async () => {
    const f = fixture({
      "message.send": { status: "partially-supported", constraints: { messageSegmentTypes: ["text"] } },
      "message.media": { status: "supported" }
    });
    expect(
      (
        await executeChannelAction(f.adapter, {
          ...f.send,
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
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["send", "upload"] as const)("%s 异常转为不可自动重试的未知结果且不泄露内容", async (kind) => {
    const f = fixture();
    (kind === "send" ? f.sendMessage : f.uploadGroupFile).mockRejectedValue(new Error("private payload"));
    const result = await executeChannelAction(f.adapter, kind === "send" ? f.send : f.upload);
    expect(result).toMatchObject({ status: "uncertain", retryable: false, errorCode: "CHANNEL_ACTION_UNCERTAIN" });
    expect(JSON.stringify(result)).not.toContain("private payload");
  });

  it("即使声明支持也拒绝尚未实现的标准动作", async () => {
    const f = fixture({ "message.delete": { status: "supported" } });
    const { message: _, ...base } = f.send;
    expect(
      (await executeChannelAction(f.adapter, { ...base, actionType: "message.delete", targetMessageId: "m1" })).status
    ).toBe("unsupported");
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("平台扩展必须匹配独立命名空间、能力与实现", async () => {
    const f = fixture({ "napcat:test": { status: "supported" } });
    const action: PlatformAction = {
      ...f.upload,
      actionType: "platform.execute",
      capability: "napcat:test",
      params: { value: 1 }
    };
    expect((await executeChannelAction(f.adapter, action)).status).toBe("unsupported");
    const executePlatformAction = vi.fn<NonNullable<ChannelAdapter["executePlatformAction"]>>(async () => ({
      status: "succeeded"
    }));
    const adapter = { ...f.adapter, executePlatformAction };
    expect((await executeChannelAction(adapter, { ...action, capability: "onebot11:test" })).status).toBe(
      "unsupported"
    );
    expect(executePlatformAction).not.toHaveBeenCalled();
    expect((await executeChannelAction(adapter, action)).status).toBe("succeeded");
    expect(executePlatformAction).toHaveBeenCalledWith(action);
  });
});
