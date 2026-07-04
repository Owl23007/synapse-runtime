import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { getTextContent, textMessage } from "@synapse/runtime-protocol";

export const QWEN_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export const OPENAI_COMPATIBLE_PROVIDER_PRESETS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  },
  qwen: {
    baseUrl: QWEN_COMPATIBLE_BASE_URL,
    model: "qwen-plus"
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat"
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k"
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash"
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash"
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.1-8b-instant"
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    model: "grok-2-latest"
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini"
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct"
  }
} as const;

export type OpenAiCompatibleProviderBase = keyof typeof OPENAI_COMPATIBLE_PROVIDER_PRESETS;
export type OpenAiCompatibleProviderBaseName = OpenAiCompatibleProviderBase | (string & {});

/* 角色 */
export type ChatRole = "system" | "user" | "assistant";

/* 聊天消息 */
export interface ChatCompletionMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/* 聊天请求 */
export interface ChatCompletionRequest {
  readonly messages: readonly ChatCompletionMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface ChatCompletionResult {
  readonly content: string;
  readonly raw?: unknown;
}

/* 服务提供商 */
export interface ChatCompletionProvider {
  readonly id: string;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export interface OpenAiCompatibleChatProviderOptions {
  readonly id: string;
  readonly apiKey: string;
  readonly base?: OpenAiCompatibleProviderBaseName;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly fetch?: FetchLike;
}

export interface QwenChatProviderOptions {
  readonly id: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly fetch?: FetchLike;
}

export interface ApiChatAgentOptions {
  readonly id: string;
  readonly provider: ChatCompletionProvider;
  readonly systemPrompt?: string;
}

type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
    };
  }[];
  readonly error?: unknown;
}

export class OpenAiCompatibleChatProvider implements ChatCompletionProvider {
  readonly id: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #temperature: number | undefined;
  readonly #maxTokens: number | undefined;
  readonly #topP: number | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #extraBody: Readonly<Record<string, unknown>>;
  readonly #fetch: FetchLike;

  constructor(options: OpenAiCompatibleChatProviderOptions) {
    const preset = resolveProviderPreset(options.base);

    this.id = options.id;
    this.#apiKey = parseRequiredString(options.apiKey, "apiKey");
    this.#baseUrl = parseRequiredString(options.baseUrl ?? preset?.baseUrl ?? "", "baseUrl");
    this.#model = parseRequiredString(options.model ?? preset?.model ?? "", "model");
    this.#temperature = options.temperature;
    this.#maxTokens = options.maxTokens;
    this.#topP = options.topP;
    this.#headers = options.headers ?? {};
    this.#extraBody = options.extraBody ?? {};
    this.#fetch = options.fetch ?? defaultFetch;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const temperature = request.temperature ?? this.#temperature;
    const maxTokens = request.maxTokens ?? this.#maxTokens;
    const topP = request.topP ?? this.#topP;
    const body = {
      ...this.#extraBody,
      ...request.extraBody,
      model: request.model ?? this.#model,
      messages: request.messages,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(topP === undefined ? {} : { top_p: topP })
    };
    const response = await this.#fetch(`${this.#baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.#headers,
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const responseBody = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      throw new Error(`Chat completion failed with HTTP ${response.status}: ${safeJson(responseBody)}`);
    }

    const content = responseBody.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.length === 0) {
      throw new Error("Chat completion response is missing choices[0].message.content.");
    }

    return {
      content,
      raw: responseBody
    };
  }
}

function resolveProviderPreset(base: OpenAiCompatibleProviderBaseName | undefined):
  | {
      readonly baseUrl: string;
      readonly model: string;
    }
  | undefined {
  if (base === undefined) {
    return undefined;
  }

  if (isKnownProviderBase(base)) {
    return OPENAI_COMPATIBLE_PROVIDER_PRESETS[base];
  }

  return undefined;
}

function isKnownProviderBase(base: string): base is OpenAiCompatibleProviderBase {
  return Object.prototype.hasOwnProperty.call(OPENAI_COMPATIBLE_PROVIDER_PRESETS, base);
}

export class ApiChatAgent implements Agent {
  readonly id: string;
  readonly #provider: ChatCompletionProvider;
  readonly #systemPrompt: string | undefined;

  constructor(options: ApiChatAgentOptions) {
    this.id = options.id;
    this.#provider = options.provider;
    this.#systemPrompt = options.systemPrompt;
  }

  async run(request: AgentRequest): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const userText = getTextContent(request.input);

    try {
      const contextMessages =
        request.promptContext?.messages.map((message) => ({
          role: message.role,
          content: message.content
        })) ?? [];
      const result = await this.#provider.complete({
        messages: [
          ...(this.#systemPrompt === undefined ? [] : [{ role: "system" as const, content: this.#systemPrompt }]),
          ...(request.promptContext?.system === undefined
            ? []
            : [{ role: "system" as const, content: request.promptContext.system }]),
          ...contextMessages,
          { role: "user", content: userText }
        ]
      });
      const finishedAt = new Date().toISOString();

      return {
        id: `run-${request.event.id}`,
        agentId: this.id,
        sessionId: request.sessionId,
        status: "succeeded",
        input: request.input,
        steps: [
          {
            id: "model-1",
            kind: "model",
            status: "succeeded",
            startedAt,
            finishedAt,
            detail: this.#provider.id
          }
        ],
        output: textMessage(result.content)
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();

      return {
        id: `run-${request.event.id}`,
        agentId: this.id,
        sessionId: request.sessionId,
        status: "failed",
        input: request.input,
        steps: [
          {
            id: "model-1",
            kind: "model",
            status: "failed",
            startedAt,
            finishedAt,
            detail: this.#provider.id
          }
        ],
        error: error instanceof Error ? error.message : "Unknown chat completion error."
      };
    }
  }
}

export function createQwenChatProvider(options: QwenChatProviderOptions): OpenAiCompatibleChatProvider {
  return new OpenAiCompatibleChatProvider({
    id: options.id,
    apiKey: options.apiKey,
    base: "qwen",
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.topP === undefined ? {} : { topP: options.topP }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
}

async function defaultFetch(url: string, init?: FetchInitLike): Promise<FetchResponseLike> {
  if (globalThis.fetch === undefined) {
    throw new Error("No fetch implementation is available in this runtime.");
  }

  return globalThis.fetch(url, init) as Promise<FetchResponseLike>;
}

function parseRequiredString(value: string, field: string): string {
  if (value.length === 0) {
    throw new Error(`Chat provider option "${field}" must not be empty.`);
  }

  return value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable response]";
  }
}
