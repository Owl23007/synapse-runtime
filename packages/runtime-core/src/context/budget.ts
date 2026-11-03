import type {
  AgentRequest,
  PromptContext,
  PromptContextBlock,
  PromptContextMessage
} from "@synapse/runtime-conversation";
import { getTextContent } from "@synapse/runtime-protocol";
import type { Tool } from "@synapse/runtime-tool-runtime";

/** 实际装配的事实来源、版本、字符成本和舍弃原因 */
export interface ContextManifest {
  readonly maxChars: number;
  readonly usedChars: number;
  readonly reservedChars: number;
  readonly entries: readonly {
    readonly source: string;
    readonly version: string;
    readonly chars: number;
    readonly adopted: boolean;
    readonly reason?: "duplicate" | "budget";
  }[];
}

/** 全部候选共享一次预算，按完整消息和区块选择，必需上下文超额时明确失败 */
export function allocateContext(
  context: PromptContext,
  maxChars: number,
  reservedChars = 0
): { context: PromptContext; manifest: ContextManifest } {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || reservedChars < 0)
    throw new Error("Invalid global context budget");
  let usedChars = reservedChars;
  if (usedChars > maxChars) throw new Error("Trusted context exceeds global budget");
  const entries: Array<ContextManifest["entries"][number]> = [];
  const seen = new Set<string>();
  const selectedBlocks = new Set<PromptContextBlock>();
  const selectedMessages = new Set<PromptContextMessage>();
  const select = (source: string, version: string, chars: number, required: boolean): boolean => {
    const key = JSON.stringify([source, version]);
    const reason = seen.has(key)
      ? ("duplicate" as const)
      : usedChars + chars > maxChars
        ? ("budget" as const)
        : undefined;
    if (reason === "budget" && required) throw new Error("Required context exceeds global budget");
    seen.add(key);
    entries.push({ source, version, chars, adopted: !reason, ...(reason ? { reason } : {}) });
    if (!reason) usedChars += chars;
    return !reason;
  };
  const blocks = context.sections
    .flatMap((section) => section.blocks.map((block) => ({ sectionId: section.id, block })))
    .toSorted((a, b) => Number(b.block.required) - Number(a.block.required) || b.block.priority - a.block.priority);
  for (const { block, sectionId } of blocks) {
    if (
      select(
        block.metadata?.sourceRef ?? `${block.source}:${sectionId}:${block.id}`,
        block.metadata?.version ?? "1",
        JSON.stringify({ role: "system", content: block.content }).length,
        block.required
      )
    )
      selectedBlocks.add(block);
  }
  // 优先保留最近完整消息，不按文本相等删除不同作者或来源的事实
  for (const [index, message] of [...context.messages.entries()].toReversed()) {
    if (
      select(
        message.sourceRef ?? message.messageId ?? `history:${index}`,
        message.createdAt ?? "1",
        JSON.stringify({ role: message.role, content: message.content }).length,
        false
      )
    )
      selectedMessages.add(message);
  }
  return {
    context: {
      ...context,
      messages: context.messages.filter((message) => selectedMessages.has(message)),
      sections: context.sections
        .map((section) => ({ ...section, blocks: section.blocks.filter((block) => selectedBlocks.has(block)) }))
        .filter((section) => section.blocks.length > 0)
    },
    manifest: { maxChars, usedChars, reservedChars, entries }
  };
}

/** 将当前输入、已编译提示词及实际可见工具定义预留在同一全局预算内 */
export function trustedContextCost(request: AgentRequest, tools: readonly Tool[]): number {
  const visible = new Set(request.invocation?.capabilities.toolIds ?? []);
  const definitions = tools
    .filter((tool) => visible.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", additionalProperties: true }
    }));
  return (
    JSON.stringify({
      messages: [
        ...(request.invocation?.prompt.blocks.map((block) => ({ role: "system", content: block.content })) ?? []),
        { role: "user", content: getTextContent(request.input) }
      ],
      tools: definitions
    }).length + 128
  );
}
