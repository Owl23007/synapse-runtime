export interface RuntimeAdminClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetch?: AdminFetch;
}

export type AdminFetch = (url: string, init?: AdminFetchInit) => Promise<AdminFetchResponse>;

export interface AdminFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface AdminFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  /** 读取 JSON 响应体 */
  json(): Promise<unknown>;
}
