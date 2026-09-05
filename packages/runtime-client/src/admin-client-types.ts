/** 管理 API 连接选项，不依赖任何服务端实现 */
export interface RuntimeAdminClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetch?: AdminFetch;
}

/** 可注入的 HTTP 传输函数 */
export type AdminFetch = (url: string, init?: AdminFetchInit) => Promise<AdminFetchResponse>;

/** 管理 API 的 HTTP 请求参数 */
export interface AdminFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** 管理 API 的 JSON 或 SSE 响应 */
export interface AdminFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  /** 读取 JSON 响应体 */
  json(): Promise<unknown>;
}
