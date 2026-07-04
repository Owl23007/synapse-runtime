import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";

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

export interface PromptContext {
  readonly system?: string;
  readonly messages: readonly PromptContextMessage[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ConversationTrigger {
  readonly kind: TriggerKind;
  readonly confidence: TriggerConfidence;
  readonly reason: ConversationDecisionReason;
}

export interface AgentRequest {
  readonly sessionId: string;
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

interface TriggerEvaluation {
  readonly reason: ConversationDecisionReason;
  readonly trigger?: ConversationTrigger;
}

export class ConversationRouter {
  readonly #options: ConversationRouterOptions;

  constructor(options: ConversationRouterOptions) {
    this.#options = options;
  }

  route(event: SynapseChannelEvent): ConversationDecision {
    if (event.eventType !== "message.created") {
      return { shouldRespond: false, reason: "not_message" };
    }

    if (event.message === undefined) {
      return { shouldRespond: false, reason: "no_message" };
    }

    const policy =
      event.conversation.kind === "private" ? this.#options.privateTrigger : this.#options.groupTrigger;
    const evaluation = evaluateTrigger(event.message, policy, event);

    if (evaluation.trigger === undefined) {
      return { shouldRespond: false, reason: evaluation.reason };
    }

    return {
      shouldRespond: true,
      reason: evaluation.reason,
      trigger: evaluation.trigger,
      request: {
        sessionId: `${event.platform}:unknown:${event.channelId}:${event.conversation.kind}:${event.conversation.id}`,
        userId: event.sender.id,
        input: event.message,
        source: {
          platform: event.platform,
          channelId: event.channelId,
          conversationId: event.conversation.id,
          conversationKind: event.conversation.kind
        },
        contextPolicy: contextPolicyForTrigger(this.#options.contextPolicy, evaluation.trigger),
        event,
        trigger: evaluation.trigger
      }
    };
  }
}

export function matchesTrigger(
  message: SynapseMessage,
  policy: ConversationTriggerPolicy,
  event?: SynapseChannelEvent
): boolean {
  if (event === undefined) {
    return legacyMatchesTrigger(message, policy);
  }

  return evaluateTrigger(message, policy, event).trigger !== undefined;
}

function evaluateTrigger(
  message: SynapseMessage,
  policy: ConversationTriggerPolicy,
  event: SynapseChannelEvent
): TriggerEvaluation {
  if (policy.mode === "never") {
    return { reason: "not_triggered" };
  }

  const replyCapability = event.adapterCapabilities?.replyToBot ?? "yes";
  if (event.triggerHint?.repliedToBot === true) {
    if (replyCapability === "no") {
      return { reason: "capability_not_supported" };
    }

    return triggered("reply_to_bot", "reply", replyCapability === "conditional" ? "platform" : "explicit");
  }

  if (message.replyTo?.messageId !== undefined && event.triggerHint?.repliedToBot === false) {
    return { reason: "reply_to_non_bot_message" };
  }

  const text = getTextContent(message);
  const commandPrefix = matchingCommandPrefix(text, policy.commandPrefixes ?? []);
  const isPrivate = event.conversation.kind === "private";
  const botUserIds = botIdsForPolicy(policy, event);
  const mentionState = classifyMentions(message, botUserIds);
  const platformMentionedBot = event.triggerHint?.platformMentionedBot === true;
  const hasKeyword = matchesKeyword(text, policy.keywords ?? []);

  if (isPrivate && commandPrefix !== undefined) {
    return triggered("command_prefix", "command", "explicit");
  }

  if (!isPrivate && commandPrefix !== undefined) {
    const allowCommandWithoutMention = policy.allowCommandWithoutMention ?? true;
    if (allowCommandWithoutMention || platformMentionedBot || mentionState === "bot") {
      return triggered("command_prefix", "command", "explicit");
    }
  }

  if (platformMentionedBot) {
    return triggered("platform_at_event", "platform_hint", "platform");
  }

  if (policy.mode === "always" && isPrivate) {
    return triggered("private_always", "private", "heuristic");
  }

  if (mentionState === "bot") {
    return triggered("mentioned_bot", "mention", "explicit");
  }

  if (mentionState === "all") {
    return { reason: "mention_all" };
  }

  if (mentionState === "unknown") {
    return { reason: "unknown_mention_ignored" };
  }

  if (mentionState === "other") {
    return { reason: "mentioned_other_user" };
  }

  if (policy.mode === "keyword" || policy.mode === "mention_or_keyword" || policy.mode === "always") {
    if (hasKeyword) {
      return triggered("keyword", "keyword", "heuristic");
    }
  }

  if (policy.mode === "always") {
    return triggered("keyword", "keyword", "heuristic");
  }

  return { reason: "not_triggered" };
}

function triggered(
  reason: ConversationDecisionReason,
  kind: TriggerKind,
  confidence: TriggerConfidence
): TriggerEvaluation {
  return {
    reason,
    trigger: {
      kind,
      confidence,
      reason
    }
  };
}

function contextPolicyForTrigger(
  policy: ContextPolicy | undefined,
  trigger: ConversationTrigger
): ContextPolicy {
  const base = policy ?? { includeHistory: true, maxMessages: 20 };

  if (trigger.kind === "command") {
    return { ...base, includeHistory: false };
  }

  return base;
}

function classifyMentions(message: SynapseMessage, botUserIds: readonly string[]): "none" | "bot" | "all" | "unknown" | "other" {
  let sawOther = false;

  for (const segment of message.segments) {
    if (segment.type !== "mention") {
      continue;
    }

    const target = segment.target ?? (segment.userId === undefined ? "unknown" : "user");
    if (target === "all") {
      return "all";
    }

    if (target === "unknown") {
      return "unknown";
    }

    if (segment.userId !== undefined && botUserIds.includes(segment.userId)) {
      return "bot";
    }

    sawOther = true;
  }

  return sawOther ? "other" : "none";
}

function botIdsForPolicy(policy: ConversationTriggerPolicy, event: SynapseChannelEvent): readonly string[] {
  return uniqueStrings([
    ...(policy.botUserIds ?? []),
    ...(event.triggerHint?.selfUserId === undefined ? [] : [event.triggerHint.selfUserId])
  ]);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function matchesKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => keyword.length > 0 && text.includes(keyword));
}

function matchingCommandPrefix(text: string, prefixes: readonly string[]): string | undefined {
  const trimmed = text.trimStart();
  return prefixes.find((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
}

function legacyMatchesTrigger(message: SynapseMessage, policy: ConversationTriggerPolicy): boolean {
  if (policy.mode === "always") {
    return true;
  }

  if (policy.mode === "never") {
    return false;
  }

  const text = getTextContent(message);
  const botUserIds = policy.botUserIds ?? [];
  const hasKeyword = matchesKeyword(text, policy.keywords ?? []);
  const mentionsBot =
    classifyMentions(message, botUserIds) === "bot" ||
    botUserIds.some((botUserId) => text.includes(`@${botUserId}`) || text.includes(`<@${botUserId}>`));

  if (policy.mode === "keyword") {
    return hasKeyword;
  }

  if (policy.mode === "mention") {
    return mentionsBot;
  }

  return hasKeyword || mentionsBot;
}
