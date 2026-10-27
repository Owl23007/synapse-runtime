import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OneBot11HttpTransport } from "./http-transport.js";
import { OneBot11WebSocketTransport } from "./websocket-transport.js";
import type { OneBot11Fetch } from "./types.js";

class Socket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  failure: "sync" | "callback" | undefined;
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  send(data: string, callback?: (error?: Error) => void): void {
    if (this.failure === "sync") throw new Error("send failed");
    this.sent.push(data);
    callback?.(this.failure === "callback" ? new Error("send failed") : undefined);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
  receive(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }
}

function websocket() {
  const sockets: Socket[] = [];
  const events: unknown[] = [];
  class HostSocket extends Socket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const transport = new OneBot11WebSocketTransport(
    { id: "qq", endpoint: "ws://unused", requestTimeoutMs: 50, WebSocketCtor: HostSocket },
    async (event) => {
      events.push(event);
    }
  );
  return { sockets, events, transport };
}

describe("OneBot11 WebSocket 请求与连接归属", () => {
  afterEach(() => vi.useRealTimers());

  it("共享建连并按 echo 匹配乱序回执，事件不消费请求", async () => {
    const f = websocket();
    const connected = f.transport.connect();
    expect(f.transport.connect()).toBe(connected);
    expect(f.sockets).toHaveLength(1);
    const socket = f.sockets[0]!;
    socket.open();
    await connected;
    const first = f.transport.call("send_msg", { value: 1 });
    const second = f.transport.call("send_msg", { value: 2 });
    const [a, b] = socket.sent.map((value) => JSON.parse(value) as { echo: string });
    expect(a!.echo).not.toBe(b!.echo);
    socket.receive({ post_type: "message", echo: a!.echo });
    socket.receive({ status: "ok", echo: "unrelated", data: "ignored" });
    socket.receive({ status: "ok", echo: b!.echo, data: "second" });
    socket.receive({ status: "ok", echo: a!.echo, data: "first" });
    expect(await first).toMatchObject({ data: "first" });
    expect(await second).toMatchObject({ data: "second" });
    expect(f.events).toHaveLength(1);
    await f.transport.disconnect();
  });

  it.each(["close", "error", "disconnect", "timeout"])("建连阶段 %s 必须结束等待并释放定时器", async (reason) => {
    vi.useFakeTimers();
    const f = websocket();
    const connecting = f.transport.connect();
    const rejected = connecting.catch((error: unknown) => error);
    if (reason === "close") f.sockets[0]!.close();
    if (reason === "error") f.sockets[0]!.emit("error", new Error("failure"));
    if (reason === "disconnect") await f.transport.disconnect();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(50);
    expect(await rejected).toBeInstanceOf(Error);
    expect(f.transport.getStatus().state).not.toBe("connecting");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["close", "error", "disconnect", "timeout", "sync", "callback"])(
    "请求阶段 %s 结束所有等待且没有遗留定时器",
    async (reason) => {
      vi.useFakeTimers();
      const f = websocket();
      const connected = f.transport.connect();
      const socket = f.sockets[0]!;
      socket.open();
      await connected;
      if (reason === "sync" || reason === "callback") socket.failure = reason;
      const pending = f.transport.call("send_msg", {});
      const rejected = pending.catch((error: unknown) => error);
      if (reason === "close") socket.close();
      if (reason === "error") socket.emit("error", new Error("failure"));
      if (reason === "disconnect") await f.transport.disconnect();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(50);
      expect(await rejected).toBeInstanceOf(Error);
      expect(vi.getTimerCount()).toBe(0);
      await f.transport.disconnect();
    }
  );

  it("断线拒绝全部并发请求，重连后旧 socket 事件不能污染新状态或回执", async () => {
    const f = websocket();
    const connected = f.transport.connect();
    const old = f.sockets[0]!;
    old.open();
    await connected;
    const first = f.transport.call("send_msg", {});
    const second = f.transport.call("send_msg", {});
    const failures = Promise.allSettled([first, second]);
    old.close();
    expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const reconnected = f.transport.connect();
    const current = f.sockets[1]!;
    current.open();
    await reconnected;
    const pending = f.transport.call("send_msg", {});
    const { echo } = JSON.parse(current.sent[0]!);
    old.receive({ status: "ok", echo, data: "stale" });
    old.emit("close");
    old.emit("error", new Error("stale"));
    expect(f.transport.getStatus().state).toBe("online");
    current.receive({ status: "ok", echo, data: "current" });
    expect(await pending).toMatchObject({ data: "current" });
    await f.transport.disconnect();
  });

  it("旧建连的清理不能覆盖断开后立即开始的新建连", async () => {
    const f = websocket();
    const old = f.transport.connect();
    const rejected = old.catch((error: unknown) => error);
    const disconnected = f.transport.disconnect();
    const current = f.transport.connect();
    await disconnected;
    expect(await rejected).toBeInstanceOf(Error);
    expect(f.transport.connect()).toBe(current);
    f.sockets[0]!.open();
    expect(f.transport.getStatus().state).toBe("connecting");
    f.sockets[1]!.open();
    await current;
    expect(f.transport.getStatus().state).toBe("online");
    await f.transport.disconnect();
  });

  it("损坏帧不打断事件流，已关联的损坏回执明确拒绝", async () => {
    const f = websocket();
    const connected = f.transport.connect();
    const socket = f.sockets[0]!;
    socket.open();
    await connected;
    socket.emit("message", "invalid json");
    socket.receive([]);
    const pending = f.transport.call("send_msg", {});
    const { echo } = JSON.parse(socket.sent[0]!);
    const rejected = pending.catch((error: unknown) => error);
    socket.receive({ status: "ok", retcode: "broken", echo });
    expect(await rejected).toBeInstanceOf(Error);
    socket.receive({ post_type: "message", message: "hello" });
    expect(f.events).toHaveLength(1);
    await f.transport.disconnect();
  });
});

describe("OneBot11 HTTP 取消边界", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["headers", "body"])("断开取消 %s 等待，即使宿主忽略 AbortSignal", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: OneBot11Fetch = async (_url, init) => {
      signal = init?.signal;
      const pending = new Promise<never>(() => {});
      return phase === "headers" ? pending : { ok: true, status: 200, json: () => pending };
    };
    const transport = new OneBot11HttpTransport({ id: "qq", endpoint: "http://unused", fetch });
    const pending = transport.call("send_msg", {});
    const rejected = pending.catch((error: unknown) => error);
    await transport.disconnect();
    expect(await rejected).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
