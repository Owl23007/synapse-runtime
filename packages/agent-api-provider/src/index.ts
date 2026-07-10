import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { getTextContent, textMessage } from "@synapse/runtime-protocol";

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
  readonly baseUrl: string;
  readonly model: string;
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
    this.id = options.id;
    this.#apiKey = parseRequiredString(options.apiKey, "apiKey");
    this.#baseUrl = parseRequiredString(options.baseUrl, "baseUrl");
    this.#model = parseRequiredString(options.model, "model");
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
