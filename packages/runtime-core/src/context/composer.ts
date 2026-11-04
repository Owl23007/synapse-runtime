import type {
  ConversationTrigger,
  PromptContext,
  PromptContextMessage,
  PromptContextSection
} from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { LineEvent } from "../conversation/types.js";
import type { ConversationStore } from "../conversation/store.js";
import type { OutputPolicy } from "../output/policy.js";
import type { TranscriptStore } from "../transcript/types.js";
import { trimHistory, isWithinHistoryTtl } from "./history.js";
import { formatZonedTimestamp } from "./time.js";
import type { RuntimeActor, WorkspaceRef } from "./types.js";
import type { MemoryStore } from "../memory/types.js";
import type { ContextGraph } from "../context-graph/index.js";
import type { AgentRequest } from "@synapse/runtime-conversation";
import type { ExecutionStore } from "../execution/store.js";
import { getTextContent } from "@synapse/runtime-protocol";

/** 组合历史、版本与记忆所需的可信存储及预算 */
export interface ContextComposerOptions {
  /** 分支只采用显式选定版本的完整快照，不回溯执行轨迹 */
  readonly graph?: ContextGraph;
  readonly transcriptStore: TranscriptStore;
  readonly memoryStore?: MemoryStore;
  readonly conversationStore?: ConversationStore;
  readonly maxHistoryChars?: number;
  readonly timezone?: string;
  readonly strategy?: string;
  readonly cacheEnabled?: boolean;
}

/** 将运行环境与低信任的历史、版本和记忆分层组合 */
export class ContextComposer {
  readonly #graph: ContextGraph | undefined;
  readonly #transcriptStore: TranscriptStore;
  readonly #memoryStore: MemoryStore | undefined;
  readonly #conversationStore: ConversationStore | undefined;
  readonly #maxHistoryChars: number;
  readonly #timezone: string;
  readonly #strategy: string;
  readonly #cacheEnabled: boolean;

  /**
   * 创建上下文组合器
   */
  constructor(options: ContextComposerOptions) {
    this.#graph = options.graph;
    this.#transcriptStore = options.transcriptStore;
    this.#memoryStore = options.memoryStore;
    this.#conversationStore = options.conversationStore;
    this.#maxHistoryChars = options.maxHistoryChars ?? 6000;
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
        .map((message): PromptContextMessage => ({
          role: message.role,
          content: `[${message.createdAt}] ${input.event.conversation.kind === "group" ? `${message.actorId ?? message.role}: ` : ""}${message.text}`,
          messageId: message.id,
          sourceRef: `${message.role}:${message.sourceEventId ?? message.id}`,
          ...(message.actorId ? { actorId: message.actorId } : {}),
          createdAt: message.createdAt
        })),
      this.#maxHistoryChars
    );

    const currentTimeIso = new Date().toISOString();
    const currentTimeLocal = formatZonedTimestamp(currentTimeIso, this.#timezone);
    const eventReceivedAtLocal = formatZonedTimestamp(input.event.receivedAt, this.#timezone);

    const conversationState = await this.#composeConversationState(input);
    const memories = await this.#composeMemories(input, this.#maxHistoryChars);

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
        ...(memories === undefined ? {} : { memories }),
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

  /** 按实际工具权限恢复同会话目标和显式相关版本，不重放历史工具动作 */
  executionSections(request: AgentRequest, store: ExecutionStore): readonly PromptContextSection[] {
    const intent = request.runId ? store.forRun(request.runId) : undefined;
    if (!intent || intent.state !== "claimed") return [];
    store.validateIntent(intent);
    const grant = store.authorize(intent.grantId);
    if (
      grant.workspaceId !== request.workspaceId ||
      grant.principalId !== request.userId ||
      (grant.sessionId !== undefined && grant.sessionId !== request.sessionId)
    )
      throw new Error("Execution scope mismatch");
    const tools = new Set(request.invocation?.capabilities.toolIds);
    const sections: PromptContextSection[] = [];
    const tasks = tools.has("task.list")
      ? store
          .listTasks(grant)
          .filter(
            (task) =>
              task.id === request.taskId ||
              (task.sessionId === request.sessionId &&
                (task.lineId === request.lineId || (!task.lineId && !request.branchId)) &&
                (task.status === "open" || task.status === "paused"))
          )
          .slice(0, 5)
          .map(({ id, revision, goal, acceptance, progress, status }) => ({
            id,
            revision,
            goal,
            acceptance,
            progress,
            status
          }))
      : [];
    const text = getTextContent(request.input);
    const continuing = /继续|接着|恢复|上次|昨天|continue|resume/i.test(text);
    // 分支已经选择独立的快照，不能把主线的最新 Head 悄悄加回分支
    const refs =
      tools.has("context.refs") && !request.branchId
        ? store
            .contextRefs(grant.sessionId ?? `private:${grant.workspaceId}:${grant.principalId}`)
            .filter((ref) => !ref.name.startsWith("line:") || ref.name === `line:${request.lineId}`)
            .slice(0, 8)
        : [];
    const relevantRefs = refs.filter((ref) => text.includes(ref.name) || text.includes(ref.commitId) || continuing);
    const snapshots = tools.has("context.read")
      ? relevantRefs
          .filter(
            (ref) =>
              text.includes(ref.name) ||
              text.includes(ref.commitId) ||
              (continuing &&
                (ref.name === `line:${request.lineId}` ||
                  (!ref.name.startsWith("line:") &&
                    relevantRefs.filter((item) => !item.name.startsWith("line:")).length === 1)))
          )
          .map((ref) => {
            const commit = this.#graph?.getCommit(
              grant.sessionId ?? `private:${grant.workspaceId}:${grant.principalId}`,
              ref.commitId
            );
            return commit ? { ...ref, content: commit.content } : ref;
          })
      : [];
    if (tasks.length || relevantRefs.length)
      sections.push({
        id: "execution-state",
        blocks: [
          {
            id: "persistent-state",
            source: "execution-store",
            trust: "external",
            stability: "turn",
            required: false,
            priority: 85,
            content: JSON.stringify({ tasks, contextRefs: relevantRefs, snapshots })
          }
        ]
      });
    return sections;
  }

  async #composeMemories(
    input: {
      readonly actor: RuntimeActor;
      readonly workspace: WorkspaceRef;
    },
    maxChars: number
  ): Promise<readonly { readonly id: string; readonly kind: string; readonly content: string }[] | undefined> {
    if (this.#memoryStore === undefined) return undefined;
    const records = await this.#memoryStore.list({
      identityId: input.actor.identity.id,
      workspaceId: input.workspace.id,
      workspaceType: input.workspace.type,
      limit: 20
    });
    if (records.length === 0) return undefined;
    const selected: Array<{ readonly id: string; readonly kind: string; readonly content: string }> = [];
    for (const record of records) {
      const candidate = { id: record.id, kind: record.kind, content: record.content };
      if (JSON.stringify([...selected, candidate]).length <= maxChars) {
        selected.push(candidate);
        continue;
      }
      if (selected.length === 0) {
        const fitted = fitMemoryRecord(candidate, maxChars);
        if (fitted !== undefined) selected.push(fitted);
      }
      break;
    }
    return selected.length === 0 ? undefined : selected;
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

    if (input.branchId !== undefined) {
      const branch = await this.#conversationStore.getBranch(input.branchId);
      if (!branch || branch.sessionId !== input.sessionId) throw new Error("Unauthorized context branch");
      const source =
        branch.contextSnapshot && typeof branch.contextSnapshot === "object"
          ? (branch.contextSnapshot as Record<string, unknown>).contextCommitId
          : undefined;
      const head = this.#graph?.getRef(input.sessionId, `line:${branch.id}`);
      const commitId = head?.commitId ?? source;
      const checkpoint = typeof commitId === "string" ? this.#graph?.getCommit(input.sessionId, commitId) : undefined;
      return JSON.stringify({
        kind: "branch",
        id: branch.id,
        title: branch.title,
        goal: branch.goal,
        reason: branch.reason,
        contextSnapshot: checkpoint ? { commitId: checkpoint.id, content: checkpoint.content } : branch.contextSnapshot
      });
    }

    const state = await this.#mainlineState(input.lineId, input.maxMessages);
    if (state === undefined) {
      return undefined;
    }
    const serialized = JSON.stringify(state);
    return serialized.length <= this.#maxHistoryChars ? serialized : undefined;
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

function fitMemoryRecord(
  candidate: { readonly id: string; readonly kind: string; readonly content: string },
  maxChars: number
): { readonly id: string; readonly kind: string; readonly content: string } | undefined {
  if (JSON.stringify([candidate]).length <= maxChars) return candidate;
  const marker = "…[truncated]";
  let content = candidate.content;
  while (content.length > 0 && JSON.stringify([{ ...candidate, content: `${content}${marker}` }]).length > maxChars) {
    content = content.slice(0, Math.max(0, content.length - 8));
  }
  return JSON.stringify([{ ...candidate, content: `${content}${marker}` }]).length <= maxChars
    ? { ...candidate, content: `${content}${marker}` }
    : undefined;
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
  readonly memories?: readonly { readonly id: string; readonly kind: string; readonly content: string }[];
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
          trust: "external",
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
  if (input.memories !== undefined) {
    sections.push({
      id: "memory",
      blocks: [
        {
          id: "durable-memory",
          trust: "external",
          source: "memory-store",
          stability: "workspace",
          required: false,
          priority: 80,
          cache: { scope: input.cacheEnabled ? "workspace" : "none" },
          content: JSON.stringify(input.memories)
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
