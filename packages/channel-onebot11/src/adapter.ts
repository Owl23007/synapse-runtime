import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEventHandler,
  ChannelStatus,
  ChannelTarget,
  SendResult
} from "@synapse/runtime-channel";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import WebSocket from "ws";
import { createOneBot11SendParams } from "./message.js";
import { normalizeOneBot11Event } from "./normalize.js";
import type {
  OneBot11ChannelAdapterOptions,
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

export class OneBot11ChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "onebot11";
  readonly provider: string;
  readonly #transport: OneBot11Transport;
  readonly #endpoint: string;
  readonly #accessToken: string | undefined;
  readonly #requestTimeoutMs: number;
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
    this.#WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  }

  async connect(): Promise<void> {
    if (this.#transport !== "websocket") {
      throw new Error(`OneBot 11 transport "${this.#transport}" is not implemented yet. Use "websocket" for NapCat.`);
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
      manageGroup: true,
      recallMessage: true,
      complianceLevel: "unofficial",
      riskLevel: "high"
    };
  }

  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    let response: OneBot11ResponsePayload;

    try {
      response = await this.#call("send_msg", createOneBot11SendParams(target, message));
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    if (response.status !== "ok" || (response.retcode !== undefined && response.retcode !== 0)) {
      return {
        ok: false,
        error: `OneBot 11 send_msg failed: ${response.message ?? response.wording ?? safeJson(response)}`
      };
    }

    return {
      ok: true,
      ...(extractMessageId(response.data) === undefined ? {} : { messageId: extractMessageId(response.data) })
    };
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

  #rejectAllPending(error: Error): void {
    for (const [echo, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(echo);
      pending.reject(new Error(`${pending.action} failed: ${error.message}`));
    }
  }
}

function extractMessageId(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  return stringFromUnknown(data.message_id);
}
