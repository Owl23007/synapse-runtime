import type { ChatCompletionMessage, ChatTokenUsage, ChatToolCall, ChatToolChoice } from "./types.js";

/** 将内部消息映射为 OpenAI 兼容消息 */
export function messageForProvider(message: ChatCompletionMessage): unknown {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.rawArguments
            }
          }))
        }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.name === undefined ? {} : { name: message.name })
  };
}

/** 将工具选择策略映射为 OpenAI 兼容结构 */
export function toolChoiceForProvider(choice: ChatToolChoice): unknown {
  return typeof choice === "string"
    ? choice
    : {
        type: "function",
        function: {
          name: choice.name
        }
      };
}

/** 解析 OpenAI 兼容响应中的工具调用 */
export function parseToolCalls(value: unknown): readonly ChatToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.function)) {
      return [];
    }
    const id = candidate.id;
    const name = candidate.function.name;
    const rawArguments = candidate.function.arguments;
    if (typeof id !== "string" || typeof name !== "string" || typeof rawArguments !== "string") {
      return [];
    }
    try {
      return [{ id, name, arguments: JSON.parse(rawArguments) as unknown, rawArguments }];
    } catch (error) {
      return [
        {
          id,
          name,
          arguments: {},
          rawArguments,
          argumentError: error instanceof Error ? error.message : "Invalid tool arguments"
        }
      ];
    }
  });
}

/** 解析 OpenAI 兼容响应中的令牌用量 */
export function parseUsage(value: unknown): { readonly usage?: ChatTokenUsage } {
  if (!isRecord(value)) {
    return {};
  }
  const promptTokens = optionalNumber(value.prompt_tokens);
  const cachedPromptTokens = isRecord(value.prompt_tokens_details)
    ? optionalNumber(value.prompt_tokens_details.cached_tokens)
    : undefined;
  const completionTokens = optionalNumber(value.completion_tokens);
  const totalTokens = optionalNumber(value.total_tokens);
  if (
    promptTokens === undefined &&
    cachedPromptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return {};
  }
  return {
    usage: {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens })
    }
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
