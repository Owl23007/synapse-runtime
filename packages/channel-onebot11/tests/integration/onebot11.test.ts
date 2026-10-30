import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { getTextContent } from "@synapse/runtime-protocol";
import { describe, expect, it } from "vitest";
import { OneBot11ChannelAdapter, normalizeOneBot11Event, renderOneBot11Message, textMessage } from "../../src/index.js";
import type { OneBot11WebSocketConstructor } from "../../src/types.js";

describe("OneBot11 事件规范化", () => {
  it("规范化包含 CQ 提及的 NapCat 群消息", () => {
    const event = normalizeOneBot11Event("qq-local", {
      time: 1_779_552_000,
      post_type: "message",
      message_type: "group",
      message_id: 123,
      group_id: 456,
      user_id: 789,
      raw_message: "[CQ:at,qq=10000] hello",
      message: [
        { type: "at", data: { qq: "10000" } },
        { type: "text", data: { text: " hello" } }
      ],
      sender: {
        user_id: 789,
        nickname: "Alice",
        role: "member"
      }
    });

    expect(event).toMatchObject({
      id: "qq-local:123",
      platform: "qq",
      channelId: "qq-local",
      eventType: "message.created",
      conversation: { id: "456", kind: "group" },
      sender: { id: "789", displayName: "Alice", roles: ["member"] },
      message: {
        id: "123",
        type: "mixed",
        segments: [
          { type: "mention", userId: "10000" },
          { type: "text", text: " hello" }
        ]
      },
      receivedAt: "2026-05-23T16:00:00.000Z"
    });
  });

  it("规范化私聊字符串消息", () => {
    const event = normalizeOneBot11Event("qq-local", {
      post_type: "message",
      message_type: "private",
      message_id: "message-1",
      user_id: "user-1",
      raw_message: "hello",
      message: "hello"
    });

    expect(event).toMatchObject({
      conversation: { id: "user-1", kind: "private" },
      sender: { id: "user-1" },
      message: {
        id: "message-1",
        type: "text",
        segments: [{ type: "text", text: "hello" }]
      }
    });
  });

  it("将未知有序片段保留为带命名空间的协议片段", () => {
    const payload = loadPlatformEvent("../../src/test-data/unknown-segments.json");
    const rawSegment = (
      payload as {
        readonly message: readonly unknown[];
      }
    ).message[1];

    const event = normalizeOneBot11Event("qq-local", payload);

    expect(event?.message).toMatchObject({
      type: "mixed",
      segments: [
        { type: "text", text: "before " },
        {
          type: "unknown",
          namespace: "onebot11",
          rawType: "face",
          fallbackText: "[CQ:face,id=14]",
          raw: rawSegment
        },
        { type: "text", text: " after" }
      ]
    });
    expect(JSON.parse(JSON.stringify(event?.message?.segments))).toEqual(event?.message?.segments);
    expect(event?.message === undefined ? undefined : getTextContent(event.message)).toBe("before  after");
  });
});

describe("OneBot11 消息渲染", () => {
  it("将文本、提及与图片渲染为 CQ 兼容消息", () => {
    expect(
      renderOneBot11Message({
        type: "mixed",
        segments: [
          { type: "text", text: "hello " },
          { type: "mention", userId: "10000" },
          { type: "text", text: " " },
          { type: "image", url: "https://example.test/a,b.png" }
        ]
      })
    ).toBe("hello [CQ:at,qq=10000] [CQ:image,file=https://example.test/a&#44;b.png]");
  });
});

describe("OneBot11 通道适配器", () => {
  it("仅声明已有适配映射的管理操作", () => {
    const adapter = new OneBot11ChannelAdapter({
      id: "qq-local",
      endpoint: "ws://127.0.0.1:3001"
    });

    expect(adapter.getCapabilities()).toMatchObject({
      capabilities: {
        "message.media": { status: "supported" },
        "message.delete": { status: "partially-supported" },
        "message.edit": { status: "unsupported" }
      }
    });
  });

  it("连接 NapCat WebSocket 并发送群消息", async () => {
    const socket = new FakeWebSocket("ws://127.0.0.1:3001", {
      headers: { authorization: "Bearer token-1" }
    });
    const adapter = new OneBot11ChannelAdapter({
      id: "qq-local",
      endpoint: "ws://127.0.0.1:3001",
      accessToken: "token-1",
      WebSocketCtor: fakeWebSocketCtor(socket)
    });

    const connectPromise = adapter.connect();
    socket.open();
    await connectPromise;

    const sendPromise = adapter.sendMessage({ type: "group", groupId: "456" }, textMessage("hello"));
    const request = JSON.parse(socket.sent.at(-1) ?? "{}") as { echo: string; action: string; params: unknown };
    expect(request).toMatchObject({
      action: "send_msg",
      params: {
        message_type: "group",
        group_id: "456",
        message: "hello",
        auto_escape: false
      }
    });

    socket.receive({ status: "ok", retcode: 0, data: { message_id: 999 }, echo: request.echo });
    await expect(sendPromise).resolves.toEqual({ status: "succeeded", messageId: "999" });
    expect(socket.endpoint).toBe("ws://127.0.0.1:3001");
    expect(socket.options).toEqual({ headers: { authorization: "Bearer token-1" } });
  });

  it("支持 HTTP 动作调用并显式处理入站载荷", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const adapter = new OneBot11ChannelAdapter({
      id: "qq-http",
      transport: "http",
      endpoint: "http://127.0.0.1:5700",
      accessToken: "token-1",
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return Response.json({ status: "ok", retcode: 0, data: { message_id: 1001 } });
      }
    });

    await adapter.connect();
    await expect(adapter.sendMessage({ type: "private", userId: "42" }, textMessage("hello"))).resolves.toEqual({
      status: "succeeded",
      messageId: "1001"
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:5700/send_msg",
        body: JSON.stringify({
          action: "send_msg",
          params: { message_type: "private", user_id: "42", message: "hello", auto_escape: false }
        })
      }
    ]);
  });

  it("分发入站消息事件", async () => {
    const socket = new FakeWebSocket("ws://127.0.0.1:3001");
    const adapter = new OneBot11ChannelAdapter({
      id: "qq-local",
      endpoint: "ws://127.0.0.1:3001",
      WebSocketCtor: fakeWebSocketCtor(socket)
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => {
      events.push(event);
    });

    const connectPromise = adapter.connect();
    socket.open();
    await connectPromise;
    socket.receive({
      post_type: "message",
      message_type: "private",
      message_id: 1,
      user_id: 2,
      raw_message: "ping",
      message: "ping"
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversation: { id: "2", kind: "private" },
      message: { segments: [{ type: "text", text: "ping" }] }
    });
  });
});

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;

  constructor(
    readonly endpoint: string,
    readonly options?: { readonly headers?: Readonly<Record<string, string>> }
  ) {
    super();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }
}

function fakeWebSocketCtor(socket: FakeWebSocket): OneBot11WebSocketConstructor {
  return class extends FakeWebSocket {
    constructor(endpoint: string, options?: { readonly headers?: Readonly<Record<string, string>> }) {
      super(endpoint, options);
      return socket;
    }
  } as unknown as OneBot11WebSocketConstructor;
}

function loadPlatformEvent(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}
