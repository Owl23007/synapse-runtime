import { describe, expect, it, vi } from "vitest";
import { channelAction, textMessage } from "@synapse/runtime-protocol";
import { executeChannelAction } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "./adapter.js";
import { createOneBot11SendParams, oneBot11SegmentsToSynapseSegments } from "./message.js";
import type { OneBot11Fetch } from "./types.js";

const target = { type: "group", groupId: "42" } as const;
function adapter(response: unknown) {
  const fetch = vi.fn<OneBot11Fetch>(async () => ({
    ok: true,
    status: 200,
    async json() {
      return response;
    }
  }));
  return {
    fetch,
    channel: new OneBot11ChannelAdapter({ id: "qq", transport: "http", endpoint: "http://onebot.invalid", fetch })
  };
}

describe("OneBot11 对原生能力的文档映射", () => {
  it("文字中的 CQ 片段保持文字，只有原生 mention 片段才能产生提及", () => {
    const message = {
      type: "mixed" as const,
      segments: [
        { type: "text" as const, text: "[CQ:at,qq=all] & literal" },
        { type: "mention" as const, target: "all" as const }
      ]
    };
    const encoded = createOneBot11SendParams(target, message);
    expect(encoded.message).toBe("&#91;CQ:at,qq=all&#93; &amp; literal[CQ:at,qq=all]");
    expect(oneBot11SegmentsToSynapseSegments(encoded.message)).toEqual(message.segments);
  });

  it("规范回复上下文映射为 CQ reply，不丢弃回复目标", () => {
    expect(
      createOneBot11SendParams(target, { ...textMessage("reply"), replyTo: { messageId: "m,1", required: true } })
        .message
    ).toBe("[CQ:reply,id=m&#44;1]reply");
  });

  it("CQ 参数转义只解码一次，保留原生标识中的实体字面量", () => {
    const encoded = createOneBot11SendParams(target, {
      ...textMessage("reply"),
      replyTo: { messageId: "m&#44;", required: true }
    });
    expect(oneBot11SegmentsToSynapseSegments(encoded.message)[0]).toEqual({ type: "reply", messageId: "m&#44;" });
  });

  it("可选交付线索兼容旧调用，必须保留的未知回复关系明确拒绝", async () => {
    const f = adapter({ status: "ok", retcode: 0, data: { message_id: "reply" } });
    const base = { actionId: "send", channelId: "qq", actionType: "message.send" as const, target };
    expect(
      (
        await executeChannelAction(
          f.channel,
          channelAction({ ...base, message: { ...textMessage("hello"), replyTo: { eventId: "event" } } })
        )
      ).status
    ).toBe("succeeded");
    expect(
      (
        await executeChannelAction(
          f.channel,
          channelAction({
            ...base,
            message: { ...textMessage("hello"), replyTo: { eventId: "event", required: true } }
          })
        )
      ).status
    ).toBe("unsupported");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("原生撤回通过统一执行器映射标准 delete_msg", async () => {
    const f = adapter({ status: "ok", retcode: 0, data: null });
    const result = await executeChannelAction(
      f.channel,
      channelAction({ actionId: "delete", channelId: "qq", actionType: "message.delete", target, targetMessageId: "m" })
    );
    expect(result).toMatchObject({ status: "succeeded", messageId: "m" });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body!)).toEqual({ action: "delete_msg", params: { message_id: "m" } });
  });

  it("明确拒绝保留平台码，超时保留未知结果，不泄露回显消息", async () => {
    const f = adapter({ status: "failed", retcode: 1200, message: "private content" });
    const action = channelAction({
      actionId: "delete",
      channelId: "qq",
      actionType: "message.delete",
      target,
      targetMessageId: "m"
    });
    const result = await executeChannelAction(f.channel, action);
    expect(result).toMatchObject({ status: "failed", platformReceipt: { code: 1200 }, retryable: false });
    expect(JSON.stringify(result)).not.toContain("private content");
    f.fetch.mockRejectedValueOnce(new Error("private token"));
    expect(await executeChannelAction(f.channel, action)).toMatchObject({ status: "uncertain", retryable: false });
  });

  it("原生文件上传可用于私聊而不冒充 OneBot 标准能力", async () => {
    const f = adapter({ status: "ok", retcode: 0, data: { file_id: "f" } });
    const result = await executeChannelAction(
      f.channel,
      channelAction({
        actionId: "file",
        channelId: "qq",
        actionType: "file.upload",
        target: { type: "private", userId: "123" },
        file: { name: "a.txt", data: new Uint8Array([65]) }
      })
    );
    expect(result).toMatchObject({ status: "succeeded", fileId: "f" });
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body!).action).toBe("upload_private_file");
    expect(f.channel.getCapabilities().capabilities["file.upload"]?.implementation).toBe("napcat:file.upload");
  });

  it("查询自发私聊消息时，对端、发送者和实际 channel 身份分别保留", async () => {
    const f = adapter({
      status: "ok",
      retcode: 0,
      data: {
        post_type: "message_sent",
        message_type: "private",
        self_id: "bot",
        user_id: "bot",
        message_id: "m",
        message: [{ type: "text", data: { text: "hello" } }]
      }
    });
    const result = await executeChannelAction(
      f.channel,
      channelAction({
        actionId: "get",
        channelId: "qq",
        actionType: "message.get",
        target: { type: "private", userId: "peer" },
        targetMessageId: "m"
      })
    );
    expect(result).toMatchObject({
      status: "succeeded",
      data: {
        kind: "message",
        message: {
          id: "m",
          origin: "outgoing",
          conversation: { id: "peer", kind: "private", channelId: "qq" },
          sender: { id: "bot", channelId: "qq" }
        }
      }
    });
  });
});
