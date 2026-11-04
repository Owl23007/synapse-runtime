/** OpenAI 兼容聊天提供商配置 */
export interface OpenAiCompatibleChatProviderOptions {
  /** 包含响应体读取的单次模型调用超时 */
  readonly timeoutMs?: number;
  /** 最终序列化请求体的字符上限，包含工具与额外参数 */
  readonly maxRequestChars?: number;
  readonly id: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly fetch?: FetchLike;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface FetchInitLike {
  readonly signal?: AbortSignal;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** 提供商响应允许按需读取 SSE，同时兼容只实现 JSON 的调用方 */
export interface FetchResponseLike {
  readonly headers?: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
