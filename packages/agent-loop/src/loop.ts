import type {
  Agent,
  AgentRun,
  AgentRuntimeContext,
  AgentStep,
  ChatCompletionMessage,
  ChatCompletionProvider,
  ChatCompletionResult,
  ChatToolCall,
  ChatToolDefinition
} from "@synapse/runtime-agent-core";
import type { AgentRequest, PromptContextBlock, PromptContextSection } from "@synapse/runtime-conversation";
import { getTextContent, textMessage } from "@synapse/runtime-protocol";
import type { ApiChatAgentOptions } from "./types.js";
/**
 * 在模型与工具之间循环执行直到产生最终文本的 Agent
 */
export class ApiChatAgent implements Agent {
  readonly id: string;
  readonly #provider: ChatCompletionProvider;
  readonly #maxSteps: number;
  readonly #maxToolCalls: number;

  /** 创建支持工具调用的聊天智能体 */
  constructor(options: ApiChatAgentOptions) {
    this.id = options.id;
    this.#provider = options.provider;
    this.#maxSteps = positiveInteger(options.maxSteps ?? 8, "maxSteps");
    this.#maxToolCalls = positiveInteger(options.maxToolCalls ?? 16, "maxToolCalls");
  }

  /** 执行一次聊天智能体运行 */
  async run(request: AgentRequest, context?: AgentRuntimeContext): Promise<AgentRun> {
    if (request.invocation === undefined) {
      throw new Error("ApiChatAgent requires a compiled Model Invocation Envelope.");
    }
    const runId = `run-${request.event.id}`;
    const userText = getTextContent(request.input);
    const steps: AgentStep[] = [];
    let toolCallCount = 0;
    const visibleToolIds = new Set(request.invocation.capabilities.toolIds);
    const availableTools = (context?.tools.list() ?? [])
      .filter((tool) => visibleToolIds.has(tool.name))
      .toSorted((left, right) => compareText(left.name, right.name));
    const toolDefinitions: ChatToolDefinition[] = availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: "object",
        additionalProperties: true
      }
    }));
    const structuredContextMessages = renderContextSections(request.promptContext?.sections);
    const compiledPromptMessages = request.invocation.prompt.blocks.map((block) => ({
      role: "system" as const,
      content: block.content
    }));
    const messages: ChatCompletionMessage[] = [
      ...compiledPromptMessages,
      ...structuredContextMessages,
      ...(request.promptContext?.messages.map((message) => ({
        role: message.role,
        content: message.content
      })) ?? []),
      { role: "user", content: userText }
    ];

    try {
      for (let stepIndex = 1; stepIndex <= this.#maxSteps; stepIndex += 1) {
        const modelStartedAt = new Date().toISOString();
        let result: ChatCompletionResult;
        try {
          // 模型步骤依赖前一步观察结果必须串行执行
          // oxlint-disable-next-line no-await-in-loop
          result = await this.#provider.complete({
            messages,
            ...(toolDefinitions.length === 0 ? {} : { tools: toolDefinitions, toolChoice: "auto" })
          });
        } catch (error) {
          steps.push({
            id: `model-${stepIndex}`,
            kind: "model",
            status: "failed",
            startedAt: modelStartedAt,
            finishedAt: new Date().toISOString(),
            detail: this.#provider.id
          });
          throw error;
        }
        const modelFinishedAt = new Date().toISOString();
        const toolCalls = result.toolCalls ?? [];
        steps.push({
          id: `model-${stepIndex}`,
          kind: "model",
          status: "succeeded",
          startedAt: modelStartedAt,
          finishedAt: modelFinishedAt,
          detail: modelStepDetail(this.#provider.id, result)
        });

        if (toolCalls.length === 0) {
          if (result.content.length === 0) {
            throw new Error("Agent loop finished without a text response.");
          }
          return {
            id: runId,
            agentId: this.id,
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps,
            output: textMessage(result.content)
          };
        }

        messages.push({
          role: "assistant",
          content: result.content.length === 0 ? null : result.content,
          toolCalls
        });
        for (const toolCall of toolCalls) {
          toolCallCount += 1;
          if (toolCallCount > this.#maxToolCalls) {
            throw new Error(`Agent loop exceeded the tool call limit of ${this.#maxToolCalls}.`);
          }
          const toolStartedAt = new Date().toISOString();
          // 工具结果需要按照模型给出的调用顺序写回上下文
          // oxlint-disable-next-line no-await-in-loop
          const observation = await executeToolCall(toolCall, runId, context);
          const toolFinishedAt = new Date().toISOString();
          steps.push({
            id: `tool-${toolCallCount}`,
            kind: "tool",
            status: observation.status,
            startedAt: toolStartedAt,
            finishedAt: toolFinishedAt,
            detail: toolCall.name
          });
          messages.push({
            role: "tool",
            content: safeJson(observation.payload),
            toolCallId: toolCall.id,
            name: toolCall.name
          });
        }
      }
      throw new Error(`Agent loop exceeded the model step limit of ${this.#maxSteps}.`);
    } catch (error) {
      return {
        id: runId,
        agentId: this.id,
        sessionId: request.sessionId,
        status: "failed",
        input: request.input,
        steps,
        error: error instanceof Error ? error.message : "Unknown chat completion error."
      };
    }
  }
}

const STABILITY_ORDER = {
  global: 0,
  workspace: 1,
  session: 2,
  turn: 3
} as const;

function renderContextSections(
  sections: readonly PromptContextSection[] | undefined
): readonly ChatCompletionMessage[] {
  if (sections === undefined || sections.length === 0) {
    return [];
  }

  return sections
    .flatMap((section) =>
      section.blocks.map((block) => ({
        block,
        sectionId: section.id
      }))
    )
    .toSorted(compareContextBlocks)
    .map(({ block }) => ({ role: "system" as const, content: block.content }));
}

function compareContextBlocks(
  left: { readonly block: PromptContextBlock; readonly sectionId: string },
  right: { readonly block: PromptContextBlock; readonly sectionId: string }
): number {
  return (
    STABILITY_ORDER[left.block.stability] - STABILITY_ORDER[right.block.stability] ||
    right.block.priority - left.block.priority ||
    compareText(left.sectionId, right.sectionId) ||
    compareText(left.block.id, right.block.id) ||
    compareText(left.block.source, right.block.source) ||
    compareText(left.block.content, right.block.content)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function executeToolCall(
  toolCall: ChatToolCall,
  runId: string,
  context: AgentRuntimeContext | undefined
): Promise<{
  readonly status: Extract<AgentStep["status"], "succeeded" | "failed" | "blocked">;
  readonly payload: unknown;
}> {
  if (toolCall.argumentError !== undefined) {
    return {
      status: "failed",
      payload: {
        status: "failed",
        error: `Tool arguments are not valid JSON: ${toolCall.argumentError}`
      }
    };
  }
  if (context === undefined) {
    return {
      status: "failed",
      payload: {
        status: "failed",
        error: "No tool runtime is available for this agent run"
      }
    };
  }
  if (!context.tools.list().some((tool) => tool.name === toolCall.name)) {
    return {
      status: "failed",
      payload: {
        status: "failed",
        error: `Unknown tool "${toolCall.name}"`
      }
    };
  }
  try {
    const result = await context.tools.call(toolCall.name, toolCall.arguments, {
      runId,
      callId: toolCall.id
    });
    if (result.status === "blocked") {
      return {
        status: "blocked",
        payload: {
          status: "blocked",
          reason: result.reason ?? "Tool execution was blocked"
        }
      };
    }
    return {
      status: "succeeded",
      payload: {
        status: "succeeded",
        output: result.output
      }
    };
  } catch (error) {
    return {
      status: "failed",
      payload: {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown tool execution error"
      }
    };
  }
}

function modelStepDetail(providerId: string, result: ChatCompletionResult): string {
  const details = [providerId];
  if (result.finishReason !== undefined) {
    details.push(`finish=${result.finishReason}`);
  }
  if (result.usage?.totalTokens !== undefined) {
    details.push(`tokens=${result.usage.totalTokens}`);
  }
  if (result.usage?.cachedPromptTokens !== undefined) {
    details.push(`cachedPromptTokens=${result.usage.cachedPromptTokens}`);
  }
  return details.join(" ");
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent option "${field}" must be a positive safe integer.`);
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
