import type {
  BranchResult,
  ConversationBranch,
  ConversationNode,
  ConversationStore,
  ConversationTask,
  LineEvent
} from "../conversation/types.js";
import type { TranscriptMessage, TranscriptStore } from "../transcript/types.js";

/**
 * 上下文投影使用的来源清单
 */
export interface BranchContextManifest {
  readonly branchHeadNodeId?: string;
  readonly snapshotId?: string;
  readonly semanticNodeIds: readonly string[];
  readonly recentMessageIds: readonly string[];
  readonly retrievedEventIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly resultIds: readonly string[];
}

/**
 * 上下文投影的预算统计
 */
export interface BranchContextBudget {
  readonly maxChars: number;
  readonly usedChars: number;
  readonly truncated: boolean;
}

/**
 * 临时重建的分支上下文视图
 */
export interface BranchContextProjection {
  readonly branchId: string;
  readonly contextText: string;
  readonly manifest: BranchContextManifest;
  readonly budget: BranchContextBudget;
}

/**
 * 构建分支上下文投影时使用的输入
 */
export interface BranchContextProjectionInput {
  readonly branchId: string;
  readonly currentInput: string;
  readonly maxChars?: number;
  readonly recentMessageLimit?: number;
  readonly recentNodeLimit?: number;
  readonly retrievedEventLimit?: number;
}

/**
 * 分支上下文投影器的配置
 */
export interface BranchContextProjectorOptions {
  readonly conversationStore: ConversationStore;
  readonly transcriptStore: TranscriptStore;
  readonly defaultMaxChars?: number;
}

/**
 * 从事实记录和语义节点按需构建分支上下文
 */
export class BranchContextProjector {
  readonly #conversationStore: ConversationStore;
  readonly #transcriptStore: TranscriptStore;
  readonly #defaultMaxChars: number;

  constructor(options: BranchContextProjectorOptions) {
    this.#conversationStore = options.conversationStore;
    this.#transcriptStore = options.transcriptStore;
    this.#defaultMaxChars = options.defaultMaxChars ?? 6000;
  }

  async project(input: BranchContextProjectionInput): Promise<BranchContextProjection> {
    const branch = await this.#conversationStore.getBranch(input.branchId);
    if (branch === undefined) {
      throw new Error(`Conversation branch "${input.branchId}" does not exist`);
    }
    const maxChars = input.maxChars ?? this.#defaultMaxChars;
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new Error("Branch context maxChars must be a positive safe integer");
    }

    const [state, nodes, messages, events, tasks, results] = await Promise.all([
      this.#conversationStore.reconstructLineState(branch.id),
      this.#conversationStore.listNodes(branch.id, {
        limit: input.recentNodeLimit ?? 6
      }),
      this.#transcriptStore.listRecent(branch.sessionId, {
        lineId: branch.id,
        limit: input.recentMessageLimit ?? 8
      }),
      this.#conversationStore.listEvents(branch.id),
      this.#conversationStore.listTasks(branch.id),
      this.#conversationStore.listBranchResults(branch.id)
    ]);
    const recentEventIds = new Set(
      messages.flatMap((message) => (message.lineEventId === undefined ? [] : [message.lineEventId]))
    );
    const retrievedEvents = rankEvidence(events, input.currentInput)
      .filter((event) => !recentEventIds.has(event.id))
      .slice(0, input.retrievedEventLimit ?? 4);
    const projectionValue = buildProjectionValue(
      branch,
      state.headNodeId,
      state.state,
      nodes,
      messages,
      tasks,
      results,
      retrievedEvents
    );
    const serialized = serializeProjection(projectionValue);
    const contextText =
      serialized.length <= maxChars ? serialized : `${serialized.slice(0, Math.max(0, maxChars - 15))}…[已按预算截断]`;

    return {
      branchId: branch.id,
      contextText,
      manifest: {
        ...(state.headNodeId === undefined ? {} : { branchHeadNodeId: state.headNodeId }),
        ...(state.snapshot === undefined ? {} : { snapshotId: state.snapshot.id }),
        semanticNodeIds: nodes.map((node) => node.id),
        recentMessageIds: messages.map((message) => message.id),
        retrievedEventIds: retrievedEvents.map((event) => event.id),
        taskIds: tasks.map((task) => task.id),
        resultIds: results.map((result) => result.id)
      },
      budget: {
        maxChars,
        usedChars: contextText.length,
        truncated: serialized.length > maxChars
      }
    };
  }
}

function buildProjectionValue(
  branch: ConversationBranch,
  headNodeId: string | undefined,
  state: Readonly<Record<string, unknown>>,
  nodes: readonly ConversationNode[],
  messages: readonly TranscriptMessage[],
  tasks: readonly ConversationTask[],
  results: readonly BranchResult[],
  evidence: readonly LineEvent[]
): unknown {
  return {
    kind: "branch",
    projection: "semantic_context",
    identity: {
      id: branch.id,
      title: branch.title,
      goal: branch.goal,
      reason: branch.reason,
      lifecycle: branch.status,
      sourceEventId: branch.sourceEventId
    },
    ...(branch.contextSnapshot === undefined ? {} : { contextSnapshot: compactValue(branch.contextSnapshot, 1200) }),
    semantic: {
      ...(headNodeId === undefined ? {} : { headNodeId }),
      state: compactValue(state, 2400),
      recentNodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        createdAt: node.createdAt,
        sourceEventIds: node.sourceEventIds,
        sourceTaskIds: node.sourceTaskIds,
        sourceResultIds: node.sourceResultIds
      }))
    },
    recentMessages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: compactValue(message.text, 800),
      createdAt: message.createdAt
    })),
    tasks: tasks.map(taskForProjection),
    results: results.map(resultForProjection),
    retrievedEvidence: evidence.map(eventForProjection)
  };
}

function taskForProjection(task: ConversationTask): unknown {
  return {
    id: task.id,
    status: task.status,
    executor: task.executor,
    ...(task.output === undefined ? {} : { output: compactValue(task.output, 600) }),
    ...(task.error === undefined ? {} : { error: compactValue(task.error, 300) }),
    artifactCount: task.artifacts.length,
    updatedAt: task.updatedAt
  };
}

function resultForProjection(result: BranchResult): unknown {
  return {
    id: result.id,
    version: result.version,
    status: result.status,
    summary: result.summary,
    nextActions: result.nextActions,
    sourceTaskIds: result.sourceTaskIds,
    createdAt: result.createdAt
  };
}

function eventForProjection(event: LineEvent): unknown {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.payload === undefined ? {} : { evidence: compactValue(event.payload, 500) })
  };
}

function compactValue(value: unknown, maxChars: number): unknown {
  const serialized = serializeProjection(value);
  return serialized.length <= maxChars ? value : `${serialized.slice(0, Math.max(0, maxChars - 13))}…[内容已压缩]`;
}

function rankEvidence(events: readonly LineEvent[], query: string): readonly LineEvent[] {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) {
    return [];
  }
  return events
    .map((event) => ({
      event,
      score: overlapScore(queryTerms, terms(eventSearchText(event)))
    }))
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => right.score - left.score || right.event.ordinal - left.event.ordinal)
    .map((candidate) => candidate.event);
}

function eventSearchText(event: LineEvent): string {
  return [event.type, event.actorId ?? "", event.taskId ?? "", serializeProjection(event.payload ?? "")]
    .join("\n")
    .slice(0, 3000);
}

function overlapScore(query: ReadonlySet<string>, candidate: ReadonlySet<string>): number {
  let overlap = 0;
  for (const term of query) {
    if (candidate.has(term)) {
      overlap += 1;
    }
  }
  return candidate.size === 0 ? 0 : overlap / Math.sqrt(query.size * candidate.size);
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.toLowerCase();
  const result = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_-]{2,}/gu) ?? []) {
    result.add(word);
  }
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      result.add(segment.slice(index, index + 2));
    }
  }
  return result;
}

function serializeProjection(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate
  );
}
