import { describe, expect, it, vi } from "vitest";
import { channelAction, textMessage, type SynapseMessage } from "@synapse/runtime-protocol";
import { executeChannelAction } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "./adapter.js";
import { QqOfficialAccessTokenClient } from "./token-client.js";
import { normalizeQqOfficialDispatch } from "./normalize.js";
import type { FetchLike, FetchResponseLike } from "./types.js";

const target = { type: "private", userId: "user-openid" } as const;
function adapter(response: FetchResponseLike) {
  const fetch = vi.fn<FetchLike>(async (url) =>
    url === "https://token.invalid"
      ? {
          ok: true,
          status: 200,
          async json() {
            return { access_token: "token", expires_in: "7200" };
          }
        }
      : response
  );
  return {
    fetch,
    channel: new QqOfficialChannelAdapter({
      id: "qq",
      appId: "app",
      appSecret: "secret",
      tokenEndpoint: "https://token.invalid",
      apiBaseUrl: "https://api.invalid",
      fetch
    })
  };
}

describe("QQ 官方接口对原生能力的文档映射", () => {
  it("HTTP 200 携带业务拒绝时不缓存令牌", async () => {
    const fetch = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { code: 100016, access_token: "must-not-use", expires_in: 7200 };
      }
    }));
    const token = new QqOfficialAccessTokenClient({ appId: "app", appSecret: "secret", fetch });
    await expect(token.getAccessToken()).rejects.toThrow("100016");
    await expect(token.getAccessToken()).rejects.toThrow("100016");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("原生撤回正确处理 HTTP 200 的空响应体", async () => {
    const json = vi.fn<() => Promise<unknown>>(async () => {
      throw new SyntaxError("empty");
    });
    const f = adapter({ ok: true, status: 200, text: async () => "", json });
    expect(
      await executeChannelAction(
        f.channel,
        channelAction({
          actionId: "delete",
          channelId: "qq",
          actionType: "message.delete",
          target,
          targetMessageId: "message/id"
        })
      )
    ).toMatchObject({ status: "succeeded", messageId: "message/id" });
    expect(f.fetch.mock.calls.at(-1)).toEqual([
      "https://api.invalid/v2/users/user-openid/messages/message%2Fid",
      { method: "DELETE", headers: { authorization: "QQBot token" } }
    ]);
    expect(json).not.toHaveBeenCalled();
  });

  it("HTTP 200 的发送失败与缺少消息标识的未知结果分别表达", async () => {
    const f = adapter({
      ok: true,
      status: 200,
      async json() {
        return { code: 40054013, message: "sensitive echoed body" };
      }
    });
    const result = await f.channel.sendMessage(target, textMessage("test"));
    expect(result).toMatchObject({ status: "failed", platformReceipt: { httpStatus: 200, code: 40054013 } });
    expect(JSON.stringify(result)).not.toContain("sensitive echoed body");
    const missing = adapter({
      ok: true,
      status: 200,
      async json() {
        return {};
      }
    });
    expect((await missing.channel.sendMessage(target, textMessage("test"))).status).toBe("uncertain");
  });

  it("混合媒体在发送前拒绝，不只发送文本或获取无用令牌", async () => {
    const f = adapter({
      ok: true,
      status: 200,
      async json() {
        return { id: "m" };
      }
    });
    expect(
      (
        await f.channel.sendMessage(target, {
          type: "mixed",
          segments: [
            { type: "text", text: "caption" },
            { type: "image", url: "https://example.test/image.png" }
          ]
        })
      ).status
    ).toBe("unsupported");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("原生 Markdown 与引用分开编码，被动回复序号重放保持稳定", async () => {
    const f = adapter({
      ok: true,
      status: 200,
      async json() {
        return { id: "m" };
      }
    });
    const message: SynapseMessage = {
      type: "mixed",
      segments: [
        { type: "rich-content", format: "markdown", value: "# Native" },
        { type: "reference", messageId: "REFIDX_native" }
      ],
      replyTo: { messageId: "passive-message", sequence: 2 }
    };
    const action = channelAction({ actionId: "send", channelId: "qq", actionType: "message.send", target, message });
    expect((await executeChannelAction(f.channel, action)).status).toBe("succeeded");
    expect((await executeChannelAction(f.channel, action)).status).toBe("succeeded");
    const bodies = f.fetch.mock.calls
      .filter(([url]) => url.includes("/messages"))
      .map(([, init]) => JSON.parse(init!.body!));
    expect(bodies[0]).toEqual({
      markdown: { content: "# Native" },
      msg_type: 2,
      msg_id: "passive-message",
      msg_seq: 2,
      message_reference: { message_id: "REFIDX_native" }
    });
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("群成员采用 member_openid，保持原生发送者身份", () => {
    const event = normalizeQqOfficialDispatch("qq", {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "m", group_openid: "group-openid", author: { member_openid: "member-openid" }, content: "hello" }
    });
    expect(event?.sender.id).toBe("member-openid");
    expect(event?.origin).toBe("incoming");
  });

  it("未实现的 WebSocket 网关不能报告在线", async () => {
    const channel = new QqOfficialChannelAdapter({ id: "qq", appId: "app", appSecret: "secret", mode: "websocket" });
    await expect(channel.connect()).rejects.toThrow("not implemented");
    expect((await channel.getStatus()).state).toBe("error");
    expect(channel.getCapabilities().capabilities["message.receive"]?.status).toBe("unsupported");
  });
});
