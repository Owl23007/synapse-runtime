import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";

export type TriggerMode = "always" | "mention" | "keyword" | "mention_or_keyword" | "never";

export interface ConversationTriggerPolicy {
  readonly mode: TriggerMode;
  readonly keywords?: readonly string[];
  readonly botUserIds?: readonly string[];
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
}

export interface AgentRequest {
  readonly sessionId: string;
  readonly userId: string;
  readonly input: SynapseMessage;
  readonly source: ChannelSource;
  readonly contextPolicy: ContextPolicy;
  readonly event: SynapseChannelEvent;
}

export interface ConversationDecision {
  readonly shouldRespond: boolean;
  readonly reason: "not_message" | "no_message" | "triggered" | "not_triggered";
  readonly request?: AgentRequest;
}

export interface ConversationRouterOptions {
  readonly groupTrigger: ConversationTriggerPolicy;
  readonly privateTrigger: ConversationTriggerPolicy;
  readonly contextPolicy?: ContextPolicy;
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

    if (!matchesTrigger(event.message, policy, event)) {
      return { shouldRespond: false, reason: "not_triggered" };
    }

    return {
      shouldRespond: true,
      reason: "triggered",
      request: {
        sessionId: `${event.platform}:${event.conversation.id}`,
        userId: event.sender.id,
        input: event.message,
        source: {
          platform: event.platform,
          channelId: event.channelId,
          conversationId: event.conversation.id,
          conversationKind: event.conversation.kind
        },
        contextPolicy: this.#options.contextPolicy ?? { includeHistory: true, maxMessages: 20 },
        event
      }
    };
  }
}

export function matchesTrigger(
  message: SynapseMessage,
  policy: ConversationTriggerPolicy,
  event?: SynapseChannelEvent
): boolean {
  if (policy.mode === "always") {
    return true;
  }

  if (policy.mode === "never") {
    return false;
  }

  const text = getTextContent(message);
  const botUserIds = policy.botUserIds ?? [];
  const hasKeyword = (policy.keywords ?? []).some((keyword) => text.includes(keyword));
  const mentionsBot =
    hasMentionSegment(message, botUserIds) ||
    botUserIds.some((botUserId) => text.includes(`@${botUserId}`) || text.includes(`<@${botUserId}>`));

  if (policy.mode === "keyword") {
    return hasKeyword;
  }

  if (policy.mode === "mention") {
    return mentionsBot;
  }

  return hasKeyword || mentionsBot;
}

function hasMentionSegment(message: SynapseMessage, botUserIds: readonly string[]): boolean {
  return message.segments.some((segment) => {
    if (segment.type !== "mention") {
      return false;
    }

    if (botUserIds.length === 0 || segment.userId === undefined) {
      return true;
    }

    return botUserIds.includes(segment.userId);
  });
}
