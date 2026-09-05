/** OpenAI 兼容聊天提供商配置 */
export interface OpenAiCompatibleChatProviderOptions {
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
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
