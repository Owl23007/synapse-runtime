import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_NATIVE_ACTIONS,
  channelAction,
  textMessage,
  type ChannelOutputAction,
  type ChannelOperationResult
} from "@synapse/runtime-protocol";
import { createChannelCapabilityProfile } from "../../src/capabilities.js";
import { executeChannelAction } from "../../src/action-executor.js";
import type { ChannelAdapter } from "../../src/types.js";

function createNativeAdapterFixture() {
  const executeAction = vi.fn<NonNullable<ChannelAdapter["executeAction"]>>(async () => ({ status: "succeeded" }));
  const adapter: ChannelAdapter = {
    id: "native",
    type: "native",
    provider: "native",
    async connect() {},
    async disconnect() {},
    onEvent() {},
    async getStatus() {
      return { state: "online", checkedAt: new Date(0).toISOString() };
    },
    getCapabilities: () =>
      createChannelCapabilityProfile({
        channelId: "native",
        adapterType: "native",
        capabilities: Object.fromEntries(
          Object.keys(CHANNEL_NATIVE_ACTIONS).map((key) => [key, { status: "supported" }])
        )
      }),
    sendMessage: vi.fn<ChannelAdapter["sendMessage"]>(async () => ({ status: "succeeded" as const })),
    executeAction
  };
  return { adapter, executeAction };
}
const base = { actionId: "a", channelId: "native", target: { type: "private", userId: "u" } as const };

describe("原生协议全集与 adapter 投影", () => {
  it("未映射能力全部显式拒绝，但原生目录不被平台子集裁剪", () => {
    const profile = createChannelCapabilityProfile({
      channelId: "qq",
      adapterType: "qq-official",
      capabilities: { "message.send": { status: "partially-supported" } }
    });
    for (const key of Object.keys(CHANNEL_NATIVE_ACTIONS) as (keyof typeof CHANNEL_NATIVE_ACTIONS)[])
      expect(profile.capabilities[key]?.status).toBe(key === "message.send" ? "partially-supported" : "unsupported");
    expect(CHANNEL_NATIVE_ACTIONS["message.stream"]).toBeDefined();
    expect(CHANNEL_NATIVE_ACTIONS["member.update"]).toBeDefined();
  });

  it.each([
    channelAction({ ...base, actionType: "message.edit", targetMessageId: "m", message: textMessage("edit") }),
    channelAction({ ...base, actionType: "message.delete", targetMessageId: "m" }),
    channelAction({ ...base, actionType: "reaction.add", targetMessageId: "m", reaction: { id: "👍" } }),
    channelAction({ ...base, actionType: "reaction.remove", targetMessageId: "m", reaction: { id: "👍" } }),
    channelAction({ ...base, actionType: "message.list", page: { limit: 20, cursor: "c" } }),
    channelAction({ ...base, actionType: "file.upload", file: { name: "a.txt", data: new Uint8Array([1]) } }),
    channelAction({ ...base, actionType: "file.get", fileId: "f" }),
    channelAction({ ...base, actionType: "file.delete", fileId: "f" }),
    channelAction({ ...base, actionType: "conversation.create", properties: { title: "native" } }),
    channelAction({ ...base, actionType: "member.update", userId: "u", changes: { roles: ["moderator"] } }),
    channelAction({ ...base, actionType: "interaction.respond", interactionId: "i", response: { status: "accepted" } }),
    channelAction({
      ...base,
      actionType: "message.stream",
      streamId: "s",
      sequence: 1,
      state: "update",
      message: textMessage("partial")
    })
  ])("完整分发 $actionType，不退化成平台扩展或文本发送", async (action) => {
    const testContext = createNativeAdapterFixture();
    expect(await executeChannelAction(testContext.adapter, action)).toMatchObject({
      status: "succeeded",
      actionType: action.actionType
    });
    expect(testContext.executeAction).toHaveBeenCalledWith(action);
    expect(testContext.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("编辑和流式消息同样校验内容与目标限制，不只校验首次发送", async () => {
    const testContext = createNativeAdapterFixture();
    testContext.adapter.getCapabilities = () =>
      createChannelCapabilityProfile({
        channelId: "native",
        adapterType: "native",
        capabilities: {
          "message.edit": { status: "partially-supported", constraints: { messageSegmentTypes: ["text"] } }
        }
      });
    const action = channelAction({
      ...base,
      actionType: "message.edit",
      targetMessageId: "m",
      message: {
        type: "mixed",
        segments: [
          { type: "text", text: "safe" },
          { type: "rich-content", format: "markdown", value: "# title" }
        ]
      }
    });
    expect((await executeChannelAction(testContext.adapter, action)).status).toBe("unsupported");
    expect(testContext.executeAction).not.toHaveBeenCalled();
  });

  it("保留查询数据、平台码和动作关联，未知结果不自动重试", async () => {
    const testContext = createNativeAdapterFixture();
    const receipt: ChannelOperationResult = {
      status: "succeeded",
      data: { kind: "files", items: [{ id: "f", name: "a.txt" }], nextCursor: "next" }
    };
    testContext.executeAction.mockResolvedValueOnce(receipt);
    expect(
      await executeChannelAction(testContext.adapter, channelAction({ ...base, actionType: "file.list" }))
    ).toMatchObject(receipt);
    testContext.executeAction.mockResolvedValueOnce({
      status: "failed",
      error: "rejected",
      platformReceipt: { httpStatus: 200, code: 40064004 }
    });
    expect(
      await executeChannelAction(
        testContext.adapter,
        channelAction({ ...base, actionType: "message.delete", targetMessageId: "m" })
      )
    ).toMatchObject({ platformReceipt: { code: 40064004 }, retryable: false });
    testContext.executeAction.mockRejectedValueOnce(new Error("private contents"));
    const result = await executeChannelAction(
      testContext.adapter,
      channelAction({ ...base, actionType: "message.delete", targetMessageId: "m" })
    );
    expect(result).toMatchObject({ status: "uncertain", retryable: false });
    expect(JSON.stringify(result)).not.toContain("private contents");
  });

  it("不允许通用原生入口绕过显式平台扩展边界", async () => {
    const testContext = createNativeAdapterFixture();
    testContext.adapter.getCapabilities = () =>
      createChannelCapabilityProfile({
        channelId: "native",
        adapterType: "native",
        capabilities: { "native:custom": { status: "supported" } }
      });
    const action = channelAction({ ...base, actionType: "platform.execute", capability: "native:custom", params: {} });
    expect((await executeChannelAction(testContext.adapter, action)).status).toBe("unsupported");
    expect(testContext.executeAction).not.toHaveBeenCalled();
  });

  it("按目标限制富内容而不限制原生消息本身", async () => {
    const testContext = createNativeAdapterFixture();
    testContext.adapter.getCapabilities = () =>
      createChannelCapabilityProfile({
        channelId: "native",
        adapterType: "native",
        capabilities: {
          "message.send": {
            status: "partially-supported",
            constraints: { richContentFormats: ["markdown"], perTarget: { private: { messageSegmentTypes: ["text"] } } }
          }
        }
      });
    const action = channelAction({
      ...base,
      actionType: "message.send",
      message: { type: "mixed", segments: [{ type: "rich-content", format: "markdown", value: "# native" }] }
    });
    expect((await executeChannelAction(testContext.adapter, action)).status).toBe("unsupported");
    const group: ChannelOutputAction = { ...action, target: { type: "group", groupId: "g" } };
    expect((await executeChannelAction(testContext.adapter, group)).status).toBe("succeeded");
  });
});
