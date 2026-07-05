import type { ConversationTrigger, PromptContext, PromptContextMessage } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { OutputPolicy } from "../output/policy.js";
import type { TranscriptStore } from "../transcript/types.js";
import { trimHistory, isWithinHistoryTtl } from "./history.js";
import { formatZonedTimestamp } from "./time.js";
import type { RuntimeActor, WorkspaceRef } from "./types.js";

export interface ContextComposerOptions {
  readonly transcriptStore: TranscriptStore;
  readonly maxHistoryChars?: number;
  readonly timezone?: string;
}

export class ContextComposer {
  readonly #transcriptStore: TranscriptStore;
  readonly #maxHistoryChars: number;
  readonly #timezone: string;

  constructor(options: ContextComposerOptions) {
    this.#transcriptStore = options.transcriptStore;
    this.#maxHistoryChars = options.maxHistoryChars ?? 6000;
    this.#timezone = options.timezone ?? "UTC";
  }

  async compose(input: {
    readonly event: SynapseChannelEvent;
    readonly actor: RuntimeActor;
    readonly workspace: WorkspaceRef;
    readonly outputPolicy: OutputPolicy;
    readonly sessionId: string;
    readonly currentInput: SynapseMessage;
    readonly currentSourceEventId?: string;
    readonly maxMessages: number;
    readonly historyTtlMinutes?: number;
    readonly trigger?: ConversationTrigger;
  }): Promise<PromptContext> {
    const eventMs = Date.parse(input.event.receivedAt);
    const referenceMs = Number.isNaN(eventMs) ? Date.now() : eventMs;
    const recent = await this.#transcriptStore.listRecent(input.sessionId, { limit: input.maxMessages });
    const messages = trimHistory(
      recent
        .filter((message) => message.sourceEventId !== input.currentSourceEventId)
        .filter((message) => isWithinHistoryTtl(message.createdAt, referenceMs, input.historyTtlMinutes))
        .map(
          (message): PromptContextMessage => ({
            role: message.role,
            content: `[${message.createdAt}] ${message.text}`,
            messageId: message.id,
            createdAt: message.createdAt
          })
        ),
      this.#maxHistoryChars
    );

    const currentTimeIso = new Date().toISOString();
    const currentTimeLocal = formatZonedTimestamp(currentTimeIso, this.#timezone);
    const eventReceivedAtLocal = formatZonedTimestamp(input.event.receivedAt, this.#timezone);

    return {
      system: buildContextSystemPrompt(input.workspace, input.outputPolicy, {
        currentTimeIso,
        currentTimeLocal,
        eventReceivedAt: input.event.receivedAt,
        eventReceivedAtLocal,
        timezone: this.#timezone
      }),
      messages,
      metadata: {
        actorId: input.actor.identity.id,
        workspaceId: input.workspace.id,
        workspaceType: input.workspace.type,
        sessionId: input.sessionId,
        currentTimeIso,
        currentTimeLocal,
        eventReceivedAt: input.event.receivedAt,
        eventReceivedAtLocal,
        timezone: this.#timezone,
        ...(input.trigger === undefined
          ? {}
          : {
              triggerKind: input.trigger.kind,
              triggerReason: input.trigger.reason,
              triggerConfidence: input.trigger.confidence
            })
      }
    };
  }
}

function buildContextSystemPrompt(
  workspace: WorkspaceRef,
  policy: OutputPolicy,
  timeContext: {
    readonly currentTimeIso: string;
    readonly currentTimeLocal: string;
    readonly eventReceivedAt: string;
    readonly eventReceivedAtLocal: string;
    readonly timezone: string;
  }
): string {
  const constraints =
    workspace.type === "group"
      ? "Group chat: answer briefly, avoid flooding, and ask whether to expand when the answer is long."
      : "Private chat: answer normally and use recent session history when relevant.";

  return `${constraints}\nCurrent input is the primary task. Historical messages are timestamped background only; do not continue an old topic unless the current input clearly asks for it.\nTime context: timezone=${timeContext.timezone}, currentLocal=${timeContext.currentTimeLocal}, currentIso=${timeContext.currentTimeIso}, eventReceivedLocal=${timeContext.eventReceivedAtLocal}, eventReceivedIso=${timeContext.eventReceivedAt}. When the user asks about the current time or date, answer using currentLocal and timezone.\nOutput policy: mode=${policy.mode}, maxChars=${policy.maxChars}, markdown=${policy.allowMarkdown}, codeBlock=${policy.allowCodeBlock}.`;
}
