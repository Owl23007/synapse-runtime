import { getTextContent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { WorkspaceRef } from "../context/types.js";

export interface OutputPolicy {
  readonly mode: "normal" | "concise" | "system";
  readonly maxChars: number;
  readonly allowMarkdown: boolean;
  readonly allowCodeBlock: boolean;
  readonly appendExpandHint: boolean;
}

/**
 * 根据工作区类型选择输出策略
 */
export class OutputPolicyResolver {
  /**
   * 解析工作区对应的输出策略
   */
  resolve(workspace: WorkspaceRef): OutputPolicy {
    if (workspace.type === "group") {
      return { mode: "concise", maxChars: 600, allowMarkdown: false, allowCodeBlock: false, appendExpandHint: true };
    }

    if (workspace.type === "system") {
      return { mode: "system", maxChars: 2000, allowMarkdown: true, allowCodeBlock: true, appendExpandHint: false };
    }

    return { mode: "normal", maxChars: 4000, allowMarkdown: true, allowCodeBlock: true, appendExpandHint: false };
  }
}

/**
 * 将输出策略应用到结构化消息
 */
export class ResponsePolicy {
  /**
   * 返回应用输出策略后的新消息
   */
  apply(message: SynapseMessage, policy: OutputPolicy): SynapseMessage {
    const text = applyTextPolicy(getTextContent(message), policy);
    return { ...message, segments: [{ type: "text", text }] };
  }
}

/**
 * 按输出策略清理并截断文本
 */
export function applyTextPolicy(text: string, policy: OutputPolicy): string {
  let output = text;

  if (!policy.allowCodeBlock) {
    output = output.replace(/```[\s\S]*?```/g, "[Code block omitted. Ask me to expand if needed.]");
  }

  if (!policy.allowMarkdown) {
    output = output
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s*\|.*\|\s*$/gm, "");
  }

  if (output.length <= policy.maxChars) {
    return output;
  }

  const hint = policy.appendExpandHint ? "\n内容较长，需要我展开再说。" : "";
  const room = Math.max(0, policy.maxChars - hint.length);
  return `${output.slice(0, room).trimEnd()}${hint}`.slice(0, policy.maxChars);
}
