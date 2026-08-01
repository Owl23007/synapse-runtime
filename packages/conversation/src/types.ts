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
  readonly system?: string;
  readonly messages: readonly PromptContextMessage[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly sections?: readonly PromptContextSection[];
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
  readonly userId: string;
  readonly input: SynapseMessage;
  readonly source: ChannelSource;
  readonly contextPolicy: ContextPolicy;
  readonly event: SynapseChannelEvent;
  readonly trigger?: ConversationTrigger;
  readonly promptContext?: PromptContext;
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
