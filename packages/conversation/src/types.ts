import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";

export type TriggerMode = "always" | "mention" | "keyword" | "mention_or_keyword" | "never";

export type TriggerKind = "private" | "mention" | "reply" | "command" | "keyword" | "platform_hint";
export type TriggerConfidence = "explicit" | "platform" | "heuristic";

export type ConversationDecisionReason =
  | "not_message"
  | "no_message"
  | "private_always"
  | "mentioned_bot"
  | "reply_to_bot"
  | "reply_to_non_bot_message"
  | "command_prefix"
  | "keyword"
  | "platform_at_event"
  | "not_triggered"
  | "mentioned_other_user"
  | "mention_all"
  | "unknown_mention_ignored"
  | "capability_not_supported";

export interface ConversationTriggerPolicy {
  readonly mode: TriggerMode;
  readonly keywords?: readonly string[];
  readonly botUserIds?: readonly string[];
  readonly commandPrefixes?: readonly string[];
  readonly allowCommandWithoutMention?: boolean;
}

export interface ContextPolicy {
  readonly includeHistory: boolean;
  readonly maxMessages: number;
}

export interface ChannelSource {
  readonly platform: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly conversationKind: string;
  readonly provider?: string;
}

export interface PromptContextMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly messageId?: string;
  readonly createdAt?: string;
}

/** Context stability controls deterministic prefix placement. */
export type PromptContextStability = "global" | "workspace" | "session" | "turn";

/** The widest boundary within which a context block may be reused. */
export type PromptContextCacheScope = "none" | "session" | "workspace" | "global";

export interface PromptContextCache {
  readonly scope: PromptContextCacheScope;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A renderable unit of structured system context. */
export interface PromptContextBlock {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly stability: PromptContextStability;
  readonly required: boolean;
  readonly priority: number;
  readonly cache?: PromptContextCache;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A logical group of context blocks. Sections do not affect rendered text. */
export interface PromptContextSection {
  readonly id: string;
  readonly blocks: readonly PromptContextBlock[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PromptContext {
  readonly messages: readonly PromptContextMessage[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly sections: readonly PromptContextSection[];
}

/** 模型调用使用的结构化场景，维度值必须来自可信运行时状态 */
export interface PromptScene {
  readonly purpose: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

/** 提示词合成后保留来源和缓存边界的不可变区块 */
export interface PromptEnvelopeBlock {
  readonly promptId: string;
  readonly version: string;
  readonly stage: "reasoning" | "internal" | "presentation" | "system" | "tool";
  readonly slot: string;
  readonly content: string;
  readonly stable: boolean;
  readonly cacheScope: "global" | "workspace" | "session" | "none";
}

/** 一次模型调用采用的结构化提示词结果 */
export interface PromptEnvelope {
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly scene: PromptScene;
  readonly blocks: readonly PromptEnvelopeBlock[];
  readonly digest: string;
}

/** 已激活 Skill 的稳定引用 */
export interface ActivatedSkill {
  readonly id: string;
  readonly version: string;
  readonly reason: string;
}

/** 模型本次可见的工具与 Skill 能力 */
export interface CapabilityEnvelope {
  readonly toolIds: readonly string[];
  readonly toolSetDigest: string;
  readonly activeSkills: readonly ActivatedSkill[];
  readonly skillSetDigest: string;
}

/** Prompt、Tools 与 Skills 编译后的模型调用契约 */
export interface ModelInvocationEnvelope {
  readonly prompt: PromptEnvelope;
  readonly capabilities: CapabilityEnvelope;
}

export interface ConversationTrigger {
  readonly kind: TriggerKind;
  readonly confidence: TriggerConfidence;
  readonly reason: ConversationDecisionReason;
}

export interface AgentRequest {
  readonly sessionId: string;
  readonly lineId?: string;
  readonly branchId?: string;
  readonly taskId?: string;
  readonly userId: string;
  readonly input: SynapseMessage;
  readonly source: ChannelSource;
  readonly contextPolicy: ContextPolicy;
  readonly event: SynapseChannelEvent;
  readonly trigger?: ConversationTrigger;
  readonly requestedSkillIds?: readonly string[];
  readonly promptContext?: PromptContext;
  readonly invocation?: ModelInvocationEnvelope;
}

export interface ConversationDecision {
  readonly shouldRespond: boolean;
  readonly reason: ConversationDecisionReason;
  readonly trigger?: ConversationTrigger;
  readonly request?: AgentRequest;
}

export interface ConversationRouterOptions {
  readonly groupTrigger: ConversationTriggerPolicy;
  readonly privateTrigger: ConversationTriggerPolicy;
  readonly contextPolicy?: ContextPolicy;
}
