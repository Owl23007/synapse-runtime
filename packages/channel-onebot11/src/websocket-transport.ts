import type { ChannelStatus } from "@synapse/runtime-channel";
import WebSocket from "ws";
import { decodeOneBot11Payload, decodeOneBot11Response, encodeOneBot11Request } from "./codec.js";
import type { OneBot11Connection } from "./transport.js";
import type {
  OneBot11ChannelAdapterOptions,
  OneBot11ResponsePayload,
  OneBot11WebSocket,
  OneBot11WebSocketConstructor
} from "./types.js";
import { stringFromUnknown } from "./utils.js";

const OPEN = 1;

interface PendingRequest {
  readonly resolve: (response: OneBot11ResponsePayload) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** WebSocket 传输拥有连接与 echo 关联，旧连接回调不能改变新连接状态 */
export class OneBot11WebSocketTransport implements OneBot11Connection {
  readonly #options: OneBot11ChannelAdapterOptions;
  readonly #WebSocketCtor: OneBot11WebSocketConstructor;
  readonly #timeoutMs: number;
  readonly #onPayload: (payload: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly #pending = new Map<string, PendingRequest>();
  #socket: OneBot11WebSocket | undefined;
  #connecting: Promise<void> | undefined;
  #cancelConnect: (() => void) | undefined;
  #sequence = 0;
  #status: ChannelStatus = { state: "offline", checkedAt: new Date(0).toISOString() };

  constructor(
    options: OneBot11ChannelAdapterOptions,
    onPayload: (payload: Readonly<Record<string, unknown>>) => Promise<unknown>
  ) {
    this.#options = options;
    this.#WebSocketCtor = options.WebSocketCtor ?? WebSocket;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#onPayload = onPayload;
  }

  /** 共享进行中的建连，关闭、错误或超时都必须结束等待 */
  connect(): Promise<void> {
    if (this.#connecting !== undefined) return this.#connecting;
    if (this.#socket?.readyState === OPEN) return Promise.resolve();
    this.#setStatus("connecting");
    let socket: OneBot11WebSocket;
    try {
      socket = new this.#WebSocketCtor(this.#options.endpoint, {
        headers: this.#options.accessToken === undefined ? {} : { authorization: `Bearer ${this.#options.accessToken}` }
      });
    } catch (error) {
      this.#setStatus("error", "OneBot 11 WebSocket construction failed.");
      return Promise.reject(error);
    }
    this.#socket = socket;
    const connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#cancelConnect = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        if (this.#socket !== socket) return;
        finish(new Error("OneBot 11 WebSocket connection timed out."));
        this.#retire(socket, "error", "OneBot 11 WebSocket connection timed out.");
      }, this.#timeoutMs);
      this.#cancelConnect = () => finish(new Error("OneBot 11 WebSocket connection cancelled."));
      socket.on("open", () => {
        if (this.#socket !== socket) return;
        this.#setStatus("online");
        finish();
      });
      socket.on("message", (data) => {
        if (this.#socket === socket) this.#handleFrame(data);
      });
      socket.on("close", () => {
        if (this.#socket !== socket) return;
        finish(new Error("OneBot 11 WebSocket closed before opening."));
        this.#socket = undefined;
        this.#rejectPending(new Error("OneBot 11 WebSocket closed."));
        this.#setStatus("offline");
      });
      socket.on("error", () => {
        if (this.#socket !== socket) return;
        finish(new Error("OneBot 11 WebSocket failed."));
        this.#retire(socket, "error", "OneBot 11 WebSocket failed.");
      });
    });
    this.#connecting = connecting;
    // 使用 then 的两条分支清理，避免 finally 派生未处理的拒绝 Promise
    const clearConnecting = () => {
      if (this.#connecting === connecting) this.#connecting = undefined;
    };
    void connecting.then(clearConnecting, clearConnecting);
    return connecting;
  }

  /** 先移除当前连接归属，再关闭 socket，避免关闭回调污染新连接 */
  async disconnect(): Promise<void> {
    this.#cancelConnect?.();
    this.#connecting = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#rejectPending(new Error("OneBot 11 adapter disconnected."));
    this.#setStatus("offline");
    if (socket?.readyState === OPEN) socket.close(1000, "runtime shutdown");
    else socket?.terminate();
  }

  /** 读取传输状态 */
  getStatus(): ChannelStatus {
    return this.#status;
  }

  /** 为并发请求分配独立 echo，发送失败、超时和断线都释放关联 */
  async call(action: string, params: Readonly<Record<string, unknown>>): Promise<OneBot11ResponsePayload> {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) throw new Error("OneBot 11 WebSocket is not connected.");
    const echo = `${this.#options.id}:${++this.#sequence}`;
    const body = encodeOneBot11Request(action, params, echo);
    return new Promise<OneBot11ResponsePayload>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.#pending.get(echo);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(echo);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("OneBot 11 WebSocket request timed out.")), this.#timeoutMs);
      this.#pending.set(echo, { resolve, reject, timeout });
      try {
        socket.send(body, (error) => {
          // ws 的真实成功回调传入 null，不能提前拒绝并丢弃稍后到达的平台回执
          if (error !== undefined && error !== null) fail(error);
        });
      } catch {
        fail(new Error("OneBot 11 WebSocket send failed."));
      }
    });
  }

  #handleFrame(data: unknown): void {
    let payload: Readonly<Record<string, unknown>> | undefined;
    try {
      payload = decodeOneBot11Payload(data);
    } catch {
      return;
    }
    if (payload === undefined) return;
    // 推送与响应分开识别，即使平台事件携带 echo 也不能消费请求回执
    if (typeof payload.post_type === "string") {
      void this.#onPayload(payload).catch(() => {
        // 业务处理失败不改变连接归属，也不能泄露原始事件
      });
      return;
    }
    const echo = stringFromUnknown(payload.echo);
    if (echo === undefined) return;
    const pending = this.#pending.get(echo);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(echo);
    try {
      pending.resolve(decodeOneBot11Response(payload));
    } catch {
      pending.reject(new Error("Invalid OneBot 11 API response."));
    }
  }

  #retire(socket: OneBot11WebSocket, state: "offline" | "error", detail: string): void {
    this.#socket = undefined;
    this.#rejectPending(new Error(detail));
    this.#setStatus(state, detail);
    socket.terminate();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setStatus(state: ChannelStatus["state"], detail?: string): void {
    this.#status = { state, checkedAt: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) };
  }
}
