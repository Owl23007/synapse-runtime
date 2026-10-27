import type { ChannelStatus } from "@synapse/runtime-channel";
import { decodeOneBot11Payload, decodeOneBot11Response, encodeOneBot11Request } from "./codec.js";
import type { OneBot11Connection } from "./transport.js";
import type { OneBot11ChannelAdapterOptions, OneBot11Fetch, OneBot11ResponsePayload } from "./types.js";

/** 无状态 HTTP 传输，超时与断开均覆盖响应体读取及不响应取消信号的宿主实现 */
export class OneBot11HttpTransport implements OneBot11Connection {
  readonly #endpoint: string;
  readonly #accessToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: OneBot11Fetch;
  readonly #pending = new Set<() => void>();
  #status: ChannelStatus = { state: "offline", checkedAt: new Date(0).toISOString() };

  constructor(options: OneBot11ChannelAdapterOptions) {
    this.#endpoint = options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`;
    this.#accessToken = options.accessToken;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? defaultFetch;
  }

  /** HTTP 不建立长连接，入站事件由宿主显式交付 */
  async connect(): Promise<void> {
    this.#status = {
      state: "online",
      detail: "OneBot 11 HTTP transport is ready; inbound events require a gateway caller.",
      checkedAt: new Date().toISOString()
    };
  }

  /** 取消所有进行中的请求，不推测平台是否已经执行 */
  async disconnect(): Promise<void> {
    for (const cancel of this.#pending) cancel();
    this.#status = { state: "offline", checkedAt: new Date().toISOString() };
  }

  /** 读取传输状态 */
  getStatus(): ChannelStatus {
    return this.#status;
  }

  /** 提交单次 API 请求，传输异常交给 API 层解释为未知回执 */
  async call(action: string, params: Readonly<Record<string, unknown>>): Promise<OneBot11ResponsePayload> {
    const body = encodeOneBot11Request(action, params);
    const controller = new AbortController();
    let cancel!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(new Error("OneBot 11 HTTP request cancelled."));
        controller.abort();
      };
      timer = setTimeout(() => {
        reject(new Error("OneBot 11 HTTP request timed out."));
        controller.abort();
      }, this.#timeoutMs);
    });
    this.#pending.add(cancel);
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(new URL(action, this.#endpoint).toString(), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.#accessToken === undefined ? {} : { authorization: `Bearer ${this.#accessToken}` })
            },
            body,
            signal: controller.signal
          });
          const payload = decodeOneBot11Payload(
            response.text === undefined ? await response.json() : await response.text()
          );
          if (!response.ok || payload === undefined) throw new Error("Invalid OneBot 11 HTTP response.");
          return decodeOneBot11Response(payload);
        })(),
        interrupted
      ]);
    } finally {
      clearTimeout(timer);
      this.#pending.delete(cancel);
    }
  }
}

const defaultFetch: OneBot11Fetch = (url, init) => globalThis.fetch(url, init);
