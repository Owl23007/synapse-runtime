/** 已实现的请求传输方式，HTTP 入站由宿主显式交付 */
export type OneBot11Transport = "websocket" | "http";

/** OneBot HTTP 请求初始化参数，取消信号覆盖请求与响应体读取 */
export interface OneBot11FetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** OneBot HTTP 响应的最小兼容契约 */
export interface OneBot11FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

/** OneBot HTTP 请求函数 */
export type OneBot11Fetch = (url: string, init?: OneBot11FetchInit) => Promise<OneBot11FetchResponse>;

/** Adapter 的连接配置与可注入传输依赖 */
export interface OneBot11ChannelAdapterOptions {
  readonly id: string;
  readonly provider?: string;
  readonly transport?: OneBot11Transport;
  readonly endpoint: string;
  readonly accessToken?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: OneBot11Fetch;
  readonly WebSocketCtor?: OneBot11WebSocketConstructor;
}

/** WebSocket 宿主依赖的最小接口，发送成功兼容 null 与 undefined 回调以保留平台回执等待 */
export interface OneBot11WebSocket {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code?: number, reason?: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: string, callback?: (error?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** 创建可注入 WebSocket 连接的构造器 */
export type OneBot11WebSocketConstructor = new (
  address: string,
  options?: { readonly headers?: Readonly<Record<string, string>> }
) => OneBot11WebSocket;

/** OneBot11 消息事件的协议字段，归一化前保留原始平台值 */
export interface OneBot11MessageEventPayload {
  readonly time?: number;
  readonly self_id?: number | string;
  readonly post_type?: string;
  readonly message_type?: "private" | "group" | string;
  readonly sub_type?: string;
  readonly message_id?: number | string;
  readonly user_id?: number | string;
  readonly group_id?: number | string;
  readonly raw_message?: string;
  readonly message?: unknown;
  readonly sender?: {
    readonly user_id?: number | string;
    readonly nickname?: string;
    readonly card?: string;
    readonly role?: string;
  };
}

/** OneBot11 API 回执，缺少终态字段时不得推测成功 */
export interface OneBot11ResponsePayload {
  readonly status?: string;
  readonly retcode?: number;
  readonly data?: unknown;
  readonly message?: string;
  readonly wording?: string;
  readonly echo?: string;
}
