import type {
  ConversationTrigger,
  PromptContext,
  PromptContextMessage,
  PromptContextSection
} from "@synapse/runtime-conversation";
import { getTextContent, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { LineEvent } from "../conversation/types.js";
import type { ConversationStore } from "../conversation/store.js";
import type { OutputPolicy } from "../output/policy.js";
import type { TranscriptStore } from "../transcript/types.js";
import { trimHistory, isWithinHistoryTtl } from "./history.js";
import { BranchContextProjector } from "./projection.js";
import { formatZonedTimestamp } from "./time.js";
import type { RuntimeActor, WorkspaceRef } from "./types.js";

export interface ContextComposerOptions {
  readonly transcriptStore: TranscriptStore;
  readonly conversationStore?: ConversationStore;
  /** 用于临时重建分支上下文的投影器 */
  readonly contextProjector?: BranchContextProjector;
  readonly maxHistoryChars?: number;
  readonly timezone?: string;
  readonly strategy?: string;
  readonly cacheEnabled?: boolean;
}

export class ContextComposer {
  readonly #transcriptStore: TranscriptStore;
  readonly #conversationStore: ConversationStore | undefined;
  readonly #contextProjector: BranchContextProjector | undefined;
  readonly #maxHistoryChars: number;
  readonly #timezone: string;
  readonly #strategy: string;
  readonly #cacheEnabled: boolean;

  /**
   * 创建上下文组合器
   */
  constructor(options: ContextComposerOptions) {
    this.#transcriptStore = options.transcriptStore;
    this.#conversationStore = options.conversationStore;
    this.#maxHistoryChars = options.maxHistoryChars ?? 6000;
    this.#contextProjector =
      options.contextProjector ??
      (options.conversationStore === undefined
        ? undefined
        : new BranchContextProjector({
            conversationStore: options.conversationStore,
            transcriptStore: options.transcriptStore,
            defaultMaxChars: this.#maxHistoryChars
          }));
    this.#timezone = options.timezone ?? "UTC";
    this.#strategy = options.strategy ?? "default";
    this.#cacheEnabled = options.cacheEnabled ?? true;
  }

  /**
   * 组合当前输入、历史记录与分支投影
   */
  async compose(input: {
    readonly event: SynapseChannelEvent;
    readonly actor: RuntimeActor;
    readonly workspace: WorkspaceRef;
    readonly outputPolicy: OutputPolicy;
    readonly sessionId: string;
    readonly lineId?: string;
    readonly branchId?: string;
    readonly currentInput: SynapseMessage;
    readonly currentSourceEventId?: string;
    readonly maxMessages: number;
    readonly includeHistory?: boolean;
    readonly historyTtlMinutes?: number;
    readonly trigger?: ConversationTrigger;
  }): Promise<PromptContext> {
    const eventMs = Date.parse(input.event.receivedAt);
    const referenceMs = Number.isNaN(eventMs) ? Date.now() : eventMs;
    const recent =
      input.includeHistory === false
        ? []
        : await this.#transcriptStore.listRecent(input.sessionId, {
            limit: input.maxMessages,
            ...(input.lineId === undefined ? {} : { lineId: input.lineId })
          });
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

    const conversationState = await this.#composeConversationState(input);

    return {
      messages,
      sections: buildContextSections({
        workspace: input.workspace,
        outputPolicy: input.outputPolicy,
        timeContext: {
          currentTimeIso,
          currentTimeLocal,
          eventReceivedAt: input.event.receivedAt,
          eventReceivedAtLocal,
          timezone: this.#timezone
        },
        ...(conversationState === undefined ? {} : { conversationState }),
        cacheEnabled: this.#cacheEnabled
      }),
      metadata: {
        actorId: input.actor.identity.id,
        workspaceId: input.workspace.id,
        workspaceType: input.workspace.type,
        sessionId: input.sessionId,
        ...(input.lineId === undefined ? {} : { lineId: input.lineId }),
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        currentTimeIso,
        currentTimeLocal,
        eventReceivedAt: input.event.receivedAt,
        eventReceivedAtLocal,
        timezone: this.#timezone,
        contextStrategy: this.#strategy,
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

  async #composeConversationState(input: {
    readonly sessionId: string;
    readonly lineId?: string;
    readonly branchId?: string;
    readonly currentInput: SynapseMessage;
    readonly maxMessages: number;
  }): Promise<string | undefined> {
    if (this.#conversationStore === undefined || input.lineId === undefined) {
      return undefined;
    }

    if (input.branchId !== undefined && this.#contextProjector !== undefined) {
      const projection = await this.#contextProjector.project({
        branchId: input.branchId,
        currentInput: getTextContent(input.currentInput),
        maxChars: this.#maxHistoryChars,
        recentMessageLimit: input.maxMessages
      });
      return projection.contextText;
    }

    const state = await this.#mainlineState(input.lineId, input.maxMessages);
    if (state === undefined) {
      return undefined;
    }
    return truncatePromptJson(state, this.#maxHistoryChars);
  }

  async #mainlineState(lineId: string, maxMessages: number): Promise<unknown | undefined> {
    const mergedResults = await this.#conversationStore?.listEvents(lineId, {
      types: ["branch_result"],
      limit: maxMessages
    });
    if (mergedResults === undefined || mergedResults.length === 0) {
      return undefined;
    }
    return {
      kind: "mainline",
      mergedBranchResults: mergedResults.map(eventForPrompt)
    };
  }
}

function buildContextSections(input: {
  readonly workspace: WorkspaceRef;
  readonly outputPolicy: OutputPolicy;
  readonly timeContext: {
    readonly currentTimeIso: string;
    readonly currentTimeLocal: string;
    readonly eventReceivedAt: string;
    readonly eventReceivedAtLocal: string;
    readonly timezone: string;
  };
  readonly conversationState?: string;
  readonly cacheEnabled: boolean;
}): readonly PromptContextSection[] {
  const workspaceBlock = {
    id: "workspace-and-output",
    source: "runtime-core",
    stability: "workspace" as const,
    required: true,
    priority: 100,
    cache: { scope: input.cacheEnabled ? ("workspace" as const) : ("none" as const) },
    content: JSON.stringify({
      workspace: input.workspace,
      conversationMode: input.workspace.type === "group" ? "group" : "private",
      outputPolicy: input.outputPolicy
    })
  };
  const sections: PromptContextSection[] = [{ id: "workspace", blocks: [workspaceBlock] }];
  if (input.conversationState !== undefined) {
    sections.push({
      id: "conversation",
      blocks: [
        {
          id: "line-state",
          source: "conversation-store",
          stability: "session",
          required: false,
          priority: 70,
          cache: { scope: input.cacheEnabled ? "session" : "none" },
          content: input.conversationState
        }
      ]
    });
  }
  sections.push({
    id: "turn",
    blocks: [
      {
        id: "time",
        source: "channel-event",
        stability: "turn",
        required: true,
        priority: 10,
        cache: { scope: "none" },
        content: JSON.stringify(input.timeContext)
      }
    ]
  });
  return sections;
}

function eventForPrompt(event: LineEvent): unknown {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
    ...(event.payload === undefined ? {} : { payload: event.payload })
  };
}

function truncatePromptJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate
  );
  if (serialized.length <= maxChars) {
    return serialized;
  }
  return `${serialized.slice(0, Math.max(0, maxChars - 16))}…[truncated]`;
}
