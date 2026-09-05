import type { ChatCompletionProvider, ChatCompletionRequest, ChatCompletionResult } from "@synapse/runtime-agent-core";
import type { FetchInitLike, FetchLike, FetchResponseLike, OpenAiCompatibleChatProviderOptions } from "./types.js";
import { messageForProvider, parseToolCalls, parseUsage, toolChoiceForProvider } from "./protocol-mapper.js";
interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: unknown;
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: unknown;
  readonly error?: unknown;
}

/**
 * 调用 OpenAI 兼容聊天接口的模型提供商
 */
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

  /** 创建 OpenAI 兼容聊天提供商 */
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

  /** 调用聊天完成接口 */
  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const temperature = request.temperature ?? this.#temperature;
    const maxTokens = request.maxTokens ?? this.#maxTokens;
    const topP = request.topP ?? this.#topP;
    const body = {
      ...this.#extraBody,
      ...request.extraBody,
      model: request.model ?? this.#model,
      messages: request.messages.map(messageForProvider),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
              }
            })),
            tool_choice: toolChoiceForProvider(request.toolChoice ?? "auto")
          }),
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

    const choice = responseBody.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    if (content.length === 0 && toolCalls.length === 0) {
      throw new Error("Chat completion response has neither text content nor tool calls.");
    }

    return {
      content,
      toolCalls,
      ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
      ...parseUsage(responseBody.usage),
      raw: responseBody
    };
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
