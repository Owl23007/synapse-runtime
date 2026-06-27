import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { OneBot11ChannelAdapter, normalizeOneBot11Event, renderOneBot11Message, textMessage } from "./index.js";
import type { OneBot11WebSocketConstructor } from "./types.js";

describe("normalizeOneBot11Event", () => {
  it("normalizes NapCat group messages with CQ mentions", () => {
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
        segments: [{ type: "mention", userId: "10000" }, { type: "text", text: " hello" }]
      },
      receivedAt: "2026-05-20T16:00:00.000Z"
    });
  });

  it("normalizes private string messages", () => {
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
});

describe("renderOneBot11Message", () => {
  it("renders text, mentions and images as CQ-compatible messages", () => {
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

describe("OneBot11ChannelAdapter", () => {
  it("connects to NapCat WebSocket and sends group messages", async () => {
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
    await expect(sendPromise).resolves.toEqual({ ok: true, messageId: "999" });
    expect(socket.endpoint).toBe("ws://127.0.0.1:3001");
    expect(socket.options).toEqual({ headers: { authorization: "Bearer token-1" } });
  });

  it("dispatches incoming message events", async () => {
    const socket = new FakeWebSocket("ws://127.0.0.1:3001");
    const adapter = new OneBot11ChannelAdapter({
      id: "qq-local",
      endpoint: "ws://127.0.0.1:3001",
      WebSocketCtor: fakeWebSocketCtor(socket)
    });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));

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
