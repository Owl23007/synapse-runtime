/** 聊天消息角色 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 聊天完成消息 */
export interface ChatCompletionMessage {
  readonly role: ChatRole;
  readonly content: string | null;
  readonly toolCalls?: readonly ChatToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

/** 模型请求执行的结构化工具调用 */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly rawArguments: string;
  readonly argumentError?: string;
}

/** 发送给模型的工具定义 */
export interface ChatToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** 模型请求的工具选择策略 */
export type ChatToolChoice = "auto" | "none" | { readonly name: string };

/** 模型调用的用量信息 */
export interface ChatTokenUsage {
  readonly promptTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** 聊天完成请求 */
export interface ChatCompletionRequest {
  readonly messages: readonly ChatCompletionMessage[];
  readonly tools?: readonly ChatToolDefinition[];
  readonly toolChoice?: ChatToolChoice;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/** 聊天完成的结构化结果 */
export interface ChatCompletionResult {
  readonly content: string;
  readonly toolCalls?: readonly ChatToolCall[];
  readonly finishReason?: string;
  readonly usage?: ChatTokenUsage;
  readonly raw?: unknown;
}

/** 聊天完成服务提供商 */
export interface ChatCompletionProvider {
  readonly id: string;
  /** 执行聊天完成请求 */
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

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

/** 工具型聊天智能体配置 */
export interface ApiChatAgentOptions {
  readonly id: string;
  readonly provider: ChatCompletionProvider;
  readonly systemPrompt?: string;
  /** 单次运行允许的最大模型步数 */
  readonly maxSteps?: number;
  /** 单次运行允许的最大工具调用数 */
  readonly maxToolCalls?: number;
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
