import { getTextContent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { WorkspaceRef } from "../context/types.js";

export interface OutputPolicy {
  readonly mode: "normal" | "concise" | "system";
  readonly maxChars: number;
  readonly allowMarkdown: boolean;
  readonly allowCodeBlock: boolean;
  readonly appendExpandHint: boolean;
}

/** 不携带人格指令、可用于安全回退的规范结果 */
export interface CanonicalResult {
  readonly message: SynapseMessage;
  readonly safeText: string;
}

/** 只允许收紧频道输出约束的确定性表达配置 */
export interface PresentationProfile {
  readonly id: string;
  readonly locale: string;
  readonly enabled: boolean;
  readonly maxChars?: number | undefined;
  readonly maxParagraphs?: number | undefined;
  readonly allowMarkdown?: boolean | undefined;
  readonly allowCodeBlock?: boolean | undefined;
}

/** 创建供表达阶段消费的规范结果 */
export function createCanonicalResult(message: SynapseMessage): CanonicalResult {
  return { message, safeText: getTextContent(message) };
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
  readonly #profile: PresentationProfile | undefined;

  /** 创建确定性表达策略 */
  constructor(profile?: PresentationProfile) {
    this.#profile = profile;
  }

  /**
   * 返回应用输出策略后的新消息
   */
  apply(message: SynapseMessage, policy: OutputPolicy): SynapseMessage {
    const canonical = createCanonicalResult(message);
    const profile = this.#profile?.enabled === true ? this.#profile : undefined;
    const effectivePolicy = tightenPolicy(policy, profile);
    const text = applyParagraphLimit(applyTextPolicy(canonical.safeText, effectivePolicy), profile?.maxParagraphs);
    return { ...message, segments: [{ type: "text", text }] };
  }
}

/** Profile 只能收紧运行时根据频道与工作区计算出的边界 */
function tightenPolicy(policy: OutputPolicy, profile: PresentationProfile | undefined): OutputPolicy {
  if (profile === undefined || !profile.enabled) {
    return policy;
  }
  return {
    ...policy,
    maxChars: profile.maxChars === undefined ? policy.maxChars : Math.min(policy.maxChars, profile.maxChars),
    allowMarkdown: policy.allowMarkdown && profile.allowMarkdown !== false,
    allowCodeBlock: policy.allowCodeBlock && profile.allowCodeBlock !== false
  };
}

/** 按空行识别自然段，避免将单行列表误判为多个段落 */
function applyParagraphLimit(text: string, maxParagraphs: number | undefined): string {
  if (maxParagraphs === undefined) {
    return text;
  }
  return text
    .split(/\n\s*\n/)
    .slice(0, maxParagraphs)
    .join("\n\n");
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
