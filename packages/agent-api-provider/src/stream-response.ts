import { ModelProviderError, type ChatCompletionRequest, type ChatCompletionResult } from "@synapse/runtime-agent-core";
import { parseToolCalls, parseUsage } from "./protocol-mapper.js";

/** 逐帧读取正文与工具参数，只有完整结束的模型流才可交给执行循环 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  request: ChatCompletionRequest,
  signal: AbortSignal
): Promise<ChatCompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const tools = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  let usage: unknown;
  let done = false;
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const consume = async (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    const value = JSON.parse(data) as {
      error?: unknown;
      usage?: unknown;
      choices?: {
        index?: number;
        finish_reason?: string | null;
        delta?: {
          content?: unknown;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    if (value.error) throw new ModelProviderError("模型流返回错误", "transport", true);
    if (value.usage) usage = value.usage;
    const choice = value.choices?.find((item) => (item.index ?? 0) === 0);
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      await request.onTextDelta?.(delta.content);
    }
    for (const tool of delta?.tool_calls ?? []) {
      if (!Number.isSafeInteger(tool.index) || tool.index < 0 || tool.index >= 128)
        throw new Error("模型工具调用索引无效");
      const current = tools.get(tool.index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" }
      };
      if (typeof tool.id === "string") current.id = tool.id;
      if (typeof tool.function?.name === "string") current.function.name += tool.function.name;
      if (typeof tool.function?.arguments === "string") current.function.arguments += tool.function.arguments;
      tools.set(tool.index, current);
    }
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      // 每次消费后再读取，观察器失败时不会继续接收或执行工具
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      size += chunk.value?.byteLength ?? 0;
      if (size > 2_000_000 || buffer.length > 262_144) throw new Error("模型流超出响应预算");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        // oxlint-disable-next-line no-await-in-loop
        await consume(frame);
        if (done) break;
      }
      if (done) break;
      if (chunk.done) {
        // 没有空行终止的最后一帧也必须按顺序交给观察器
        // oxlint-disable-next-line no-await-in-loop
        if (buffer.trim() && !done) await consume(buffer);
        break;
      }
    }
    if (!finishReason) throw new ModelProviderError("模型流提前结束，未收到完成回执", "transport", true);
    const ordered = [...tools.entries()].toSorted(([a], [b]) => a - b).map(([, value]) => value);
    if (ordered.some((tool) => !tool.id || !tool.function.name)) throw new Error("模型工具调用缺少身份或名称");
    const toolCalls = parseToolCalls(ordered);
    if (!content && !toolCalls.length) throw new Error("模型流没有正文或工具调用");
    return { content, toolCalls, finishReason, ...parseUsage(usage) };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
