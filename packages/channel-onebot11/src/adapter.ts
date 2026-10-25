import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEventHandler,
  ChannelStatus,
  ChannelTarget,
  GroupFileUpload,
  GroupFileUploadResult,
  SendResult
} from "@synapse/runtime-channel";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import WebSocket from "ws";
import { createOneBot11SendParams } from "./message.js";
import { normalizeOneBot11Event } from "./normalize.js";
import type {
  OneBot11ChannelAdapterOptions,
  OneBot11Fetch,
  OneBot11FetchInit,
  OneBot11ResponsePayload,
  OneBot11Transport,
  OneBot11WebSocket,
  OneBot11WebSocketConstructor
} from "./types.js";
import { isRecord, parseJsonPayload, safeJson, stringFromUnknown } from "./utils.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const WEBSOCKET_OPEN = 1;

interface PendingRequest {
  readonly action: string;
  readonly resolve: (response: OneBot11ResponsePayload) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** 通过 OneBot11 收发消息，NapCat 扩展能力必须单独声明和校验 */
export class OneBot11ChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "onebot11";
  readonly provider: string;
  readonly #transport: OneBot11Transport;
  readonly #endpoint: string;
  readonly #accessToken: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #fetch: OneBot11Fetch;
  readonly #WebSocketCtor: OneBot11WebSocketConstructor;
  readonly #handlers = new Set<ChannelEventHandler>();
  readonly #pending = new Map<string, PendingRequest>();
  #socket: OneBot11WebSocket | undefined;
  #status: ChannelStatus = { state: "offline", checkedAt: new Date(0).toISOString() };
  #requestSequence = 0;

  constructor(options: OneBot11ChannelAdapterOptions) {
    this.id = options.id;
    this.provider = options.provider ?? "napcat";
    this.#transport = options.transport ?? "websocket";
    this.#endpoint = options.endpoint;
    this.#accessToken = options.accessToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  }

  async connect(): Promise<void> {
    if (this.#transport === "http") {
      this.#status = {
        state: "online",
        detail: `OneBot 11 HTTP transport is ready for ${this.provider}; inbound events require a gateway caller.`,
        checkedAt: new Date().toISOString()
      };
      return;
    }

    if (this.#socket !== undefined && this.#socket.readyState === WEBSOCKET_OPEN) {
      return;
    }

    this.#status = { state: "connecting", checkedAt: new Date().toISOString() };
    const socket = new this.#WebSocketCtor(this.#endpoint, {
      headers: this.#accessToken === undefined ? {} : { authorization: `Bearer ${this.#accessToken}` }
    });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };

      socket.on("open", () => {
        this.#status = {
          state: "online",
          detail: `Connected to ${this.provider} OneBot 11 WebSocket.`,
          checkedAt: new Date().toISOString()
        };
        settle(resolve);
      });
      socket.on("message", (data) => {
        void this.#handleMessage(data);
      });
      socket.on("close", (_code, reason) => {
        this.#rejectAllPending(new Error("OneBot 11 WebSocket closed."));
        this.#status = {
          state: "offline",
          ...(reason === undefined || reason.length === 0 ? {} : { detail: reason.toString("utf8") }),
          checkedAt: new Date().toISOString()
        };
      });
      socket.on("error", (error) => {
        this.#status = { state: "error", detail: error.message, checkedAt: new Date().toISOString() };
        settle(() => reject(error));
      });
    });
  }

  async disconnect(): Promise<void> {
    this.#rejectAllPending(new Error("OneBot 11 adapter disconnected."));
    const socket = this.#socket;
    this.#socket = undefined;

    if (socket !== undefined && socket.readyState === WEBSOCKET_OPEN) {
      socket.close(1000, "runtime shutdown");
    }

    this.#status = { state: "offline", checkedAt: new Date().toISOString() };
  }

  async getStatus(): Promise<ChannelStatus> {
    return this.#status;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      receivePrivateMessage: true,
      receiveGroupMessage: true,
      receiveAllGroupMessages: true,
      requiresMention: false,
      sendPrivateMessage: true,
      sendGroupMessage: true,
      sendMedia: true,
      uploadGroupFile: this.provider === "napcat",
      manageGroup: false,
      recallMessage: false,
      complianceLevel: "unofficial",
      riskLevel: "high"
    };
  }

  /** 先交付真实文件再发送说明，文件上传失败时返回失败而不丢弃附件 */
  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    const files = message.segments.filter((segment) => segment.type === "file");
    if (files.length > 0 && target.type !== "private" && target.type !== "group") {
      return { ok: false, error: "OneBot 11 file uploads require a private or group target." };
    }
    if (files.some((file) => file.url === undefined)) {
      return { ok: false, error: "OneBot 11 file uploads require a file URL or base64 resource." };
    }
    for (const file of files) {
      const action = target.type === "group" ? "upload_group_file" : "upload_private_file";
      try {
        // NapCat 在自己的文件系统解析路径，base64 资源允许部署在不同容器的 Runtime 直接交付
        // oxlint-disable-next-line no-await-in-loop
        const uploaded = await this.#call(action, {
          ...(target.type === "group"
            ? { group_id: target.groupId }
            : target.type === "private"
              ? { user_id: target.userId }
              : {}),
          file: file.url,
          name: file.name,
          upload_file: true
        });
        if (uploaded.status === "failed" && file === files[0]) {
          return {
            ok: false,
            error: `OneBot 11 ${action} failed: ${uploaded.message ?? uploaded.wording ?? "Upload rejected"}`
          };
        }
        if (uploaded.status !== "ok" || (uploaded.retcode !== undefined && uploaded.retcode !== 0)) {
          throw new Error("文件上传未确认终态或已发生部分交付");
        }
      } catch {
        // 未知回执与部分交付不能标记为可重试失败，否则恢复时会重复上传
        throw new Error("文件上传回执未确认，请核对文件后再决定是否重新发送");
      }
    }
    const remaining = message.segments.filter((segment) => segment.type !== "file");
    if (
      files.length > 0 &&
      !remaining.some((segment) => segment.type === "image" || (segment.type === "text" && segment.text.length > 0))
    ) {
      return { ok: true };
    }
    let response: OneBot11ResponsePayload;

    try {
      response = await this.#call("send_msg", createOneBot11SendParams(target, { ...message, segments: remaining }));
    } catch (error) {
      if (files.length > 0)
        throw new Error("附件已上传，说明消息回执未确认，请核对后再决定是否重新发送", { cause: error });
      // 请求发出后传输异常不能证明平台未执行，交给 Runtime 的未知回执恢复路径
      throw new Error("消息发送回执未确认，请核对后再决定是否重新发送", { cause: error });
    }

    if (response.status !== "ok" || (response.retcode !== undefined && response.retcode !== 0)) {
      if (files.length > 0) throw new Error("附件已上传，说明消息发送失败，请核对后再决定是否重新发送");
      if (response.status !== "failed") throw new Error("消息发送未获得明确终态，请核对后再决定是否重新发送");
      return {
        ok: false,
        error: `OneBot 11 send_msg failed: ${response.message ?? response.wording ?? safeJson(response)}`
      };
    }

    const messageId = extractMessageId(response.data);

    return {
      ok: true,
      ...(messageId === undefined ? {} : { messageId })
    };
  }

  /** 使用内容传输上传群文件，避免假设远端 NapCat 可以读取本机路径 */
  async uploadGroupFile(groupId: string, file: GroupFileUpload): Promise<GroupFileUploadResult> {
    if (!this.getCapabilities().uploadGroupFile)
      return { status: "unsupported", error: "当前 OneBot 提供方未声明群文件上传能力" };
    if (
      !/^\d+$/.test(groupId) ||
      file.name.length === 0 ||
      file.name.length > 120 ||
      /[\\/:]/.test(file.name) ||
      [...file.name].some((c) => c.charCodeAt(0) < 32)
    ) {
      return { status: "failed", error: "群标识或文件名无效" };
    }
    if (file.data.byteLength === 0 || file.data.byteLength > 10_485_760)
      return { status: "failed", error: "群文件必须介于 1 字节和 10 MiB 之间" };
    try {
      const response = await this.#call("upload_group_file", {
        group_id: groupId,
        file: `base64://${Buffer.from(file.data).toString("base64")}`,
        name: file.name,
        upload_file: true
      });
      if (response.status === "failed") {
        // 明确的平台拒绝与未知网络结果分开，恢复逻辑不能把超时当成可安全重试
        return {
          status: "failed",
          error: `NapCat 拒绝群文件上传，错误码：${response.retcode ?? "unknown"}`
        };
      }
      // 异步受理或损坏的响应都不是明确失败，不能据此安全重放上传
      if (response.status !== "ok" || (response.retcode !== undefined && response.retcode !== 0))
        return { status: "uncertain", error: "群文件上传未返回明确终态，请先核对群文件" };
      const fileId = isRecord(response.data) ? stringFromUnknown(response.data.file_id) : undefined;
      return { status: "succeeded", ...(fileId === undefined ? {} : { fileId }) };
    } catch {
      // 不透传可能包含文件 base64 的外部错误，回执不确定时也不伪造成功
      return { status: "uncertain", error: "群文件上传回执未确认，请核对群文件后再决定是否重新生成并上传" };
    }
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async handlePayload(payload: unknown): Promise<readonly SynapseChannelEvent[]> {
    if (!isRecord(payload)) {
      return [];
    }

    const event = normalizeOneBot11Event(this.id, payload);
    if (event === undefined) {
      return [];
    }

    await Promise.all([...this.#handlers].map((handler) => handler(event)));
    return [event];
  }

  async #handleMessage(data: unknown): Promise<void> {
    let payload: unknown;

    try {
      payload = parseJsonPayload(data);
    } catch {
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    const echo = stringFromUnknown(payload.echo);
    if (echo !== undefined) {
      const pending = this.#pending.get(echo);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pending.delete(echo);
        pending.resolve(payload);
        return;
      }
    }

    await this.handlePayload(payload);
  }

  async #call(action: string, params: Readonly<Record<string, unknown>>): Promise<OneBot11ResponsePayload> {
    if (this.#transport === "http" || this.#transport === "http-websocket") {
      return this.#callHttp(action, params);
    }
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WEBSOCKET_OPEN) {
      throw new Error("OneBot 11 WebSocket is not connected.");
    }

    const echo = `${this.id}:${Date.now()}:${++this.#requestSequence}`;
    const body = JSON.stringify({ action, params, echo });

    return new Promise<OneBot11ResponsePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`OneBot 11 action "${action}" timed out after ${this.#requestTimeoutMs}ms.`));
      }, this.#requestTimeoutMs);

      this.#pending.set(echo, { action, resolve, reject, timeout });
      socket.send(body, (error) => {
        if (error === undefined) {
          return;
        }

        clearTimeout(timeout);
        this.#pending.delete(echo);
        reject(error);
      });
    });
  }

  async #callHttp(action: string, params: Readonly<Record<string, unknown>>): Promise<OneBot11ResponsePayload> {
    const base = this.#endpoint.endsWith("/") ? this.#endpoint : `${this.#endpoint}/`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 除了中止原生 fetch，还约束不响应取消信号的宿主实现，避免上传永久占用运行
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`OneBot 11 action "${action}" timed out after ${this.#requestTimeoutMs}ms.`));
        controller.abort();
      }, this.#requestTimeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(new URL(action, base).toString(), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.#accessToken === undefined ? {} : { authorization: `Bearer ${this.#accessToken}` })
            },
            body: JSON.stringify({ action, params }),
            signal: controller.signal
          });
          const payload = response.text === undefined ? await response.json() : parseJsonPayload(await response.text());
          if (!response.ok || !isRecord(payload)) {
            throw new Error(`OneBot 11 HTTP action "${action}" returned an invalid response.`);
          }
          return payload as OneBot11ResponsePayload;
        })(),
        timeout
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #rejectAllPending(error: Error): void {
    for (const [echo, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(echo);
      pending.reject(new Error(`${pending.action} failed: ${error.message}`));
    }
  }
}

async function defaultFetch(input: string, init?: OneBot11FetchInit): Promise<Response> {
  if (globalThis.fetch === undefined)
    throw new Error("No fetch implementation is available for OneBot 11 HTTP transport.");
  return globalThis.fetch(input, init);
}

function extractMessageId(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  return stringFromUnknown(data.message_id);
}
