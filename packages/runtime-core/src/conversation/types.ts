import type { ChannelTriggerHint, MessageSegment, SynapseMessage } from "@synapse/runtime-protocol";

export type SessionStatus = "active" | "archived";
export type MainlineStatus = "active" | "archived";
export type BranchStatus =
  | "created"
  | "active"
  | "blocked"
  | "inactive"
  | "completed"
  | "merged"
  | "failed"
  | "cancelled"
  | "archived";
export type TaskStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type BranchResultStatus = "completed" | "failed" | "cancelled";
/**
 * 语义节点记录一次值得独立追踪的上下文变化
 */
export type ConversationNodeKind =
  | "topic_created"
  | "focus_changed"
  | "decision"
  | "assumption_rejected"
  | "question_opened"
  | "question_resolved"
  | "task_result"
  | "context_resumed"
  | "fork"
  | "merge"
  | (string & {});

/**
 * 语义状态补丁采用 JSON Merge Patch 语义
 */
export type ConversationStatePatch = Readonly<Record<string, unknown>>;

export type LineEventType =
  | "user_message"
  | "assistant_message"
  | "system_message"
  | "tool_call"
  | "tool_result"
  | "branch_created"
  | "branch_status_changed"
  | "task_created"
  | "task_status_changed"
  | "branch_result"
  | "branch_merged"
  | "correction"
  | "session_status_changed"
  | "delivery_uncertain"
  | (string & {});

export interface ConversationSessionLocator {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: string;
  readonly conversationId: string;
}

export interface ConversationSession {
  readonly id: string;
  readonly mainlineId: string;
  readonly status: SessionStatus;
  readonly locator?: ConversationSessionLocator;
  readonly workspaceId?: string;
  readonly metadata?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMainline {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: "mainline";
  readonly status: MainlineStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationBranch {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: "branch";
  readonly parentMainlineId: string;
  readonly sourceEventId: string;
  readonly title: string;
  readonly goal: string;
  readonly reason: string;
  readonly status: BranchStatus;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly contextSnapshot?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly mergedAt?: string;
  readonly archivedAt?: string;
}

export type ConversationLine = ConversationMainline | ConversationBranch;

export interface NormalizedEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly lineId: string;
  readonly lineEventId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: string;
  readonly conversationId: string;
  readonly sourceEventId: string;
  readonly sourceMessageId?: string;
  readonly sourceEventType: string;
  readonly senderId: string;
  readonly text: string;
  readonly message?: SynapseMessage;
  readonly segments: readonly MessageSegment[];
  readonly triggerHint?: ChannelTriggerHint;
  readonly rawPayload?: unknown;
  readonly receivedAt: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
}

export interface LineEvent {
  readonly id: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly sessionId: string;
  readonly lineId: string;
  readonly type: LineEventType;
  readonly idempotencyKey: string;
  readonly sourceNormalizedEventId?: string;
  readonly sourceEventId?: string;
  readonly causationEventId?: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly actorId?: string;
  readonly payload?: unknown;
  readonly createdAt: string;
}

export interface ConversationTask {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly status: TaskStatus;
  readonly executor: string;
  readonly workspaceId?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly artifacts: readonly unknown[];
  readonly idempotencyKey: string;
  readonly sourceEventId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface BranchResult {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly version: number;
  readonly status: BranchResultStatus;
  readonly summary: string;
  readonly artifacts: readonly unknown[];
  readonly citations: readonly unknown[];
  readonly nextActions: readonly string[];
  readonly sourceTaskIds: readonly string[];
  readonly idempotencyKey: string;
  readonly sourceEventId?: string;
  readonly createdAt: string;
}

export interface BranchMerge {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly resultId: string;
  readonly mainlineId: string;
  readonly mainlineEventId: string;
  readonly branchEventId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * 不可变的会话语义节点
 */
export interface ConversationNode {
  readonly id: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly sessionId: string;
  readonly lineId: string;
  readonly parentIds: readonly string[];
  readonly kind: ConversationNodeKind;
  readonly title: string;
  readonly statePatch: ConversationStatePatch;
  readonly sourceEventIds: readonly string[];
  readonly sourceTaskIds: readonly string[];
  readonly sourceResultIds: readonly string[];
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * 指向某条语义路径最新节点的可移动引用
 */
export interface ConversationLineHead {
  readonly lineId: string;
  readonly nodeId: string;
  readonly updatedAt: string;
}

/**
 * 从语义节点派生的上下文检查点
 */
export interface ConversationContextSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly lineId: string;
  readonly nodeId: string;
  readonly nodeOrdinal: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * 按节点图重建得到的临时语义状态
 */
export interface ReconstructedConversationState {
  readonly sessionId: string;
  readonly lineId: string;
  readonly headNodeId?: string;
  readonly snapshot?: ConversationContextSnapshot;
  readonly state: Readonly<Record<string, unknown>>;
  readonly appliedNodeIds: readonly string[];
}

export interface CreateSessionInput {
  /**
   * `sessionId` is accepted as an alias so callers can pass an existing
   * runtime session identifier without reshaping it.
   */
  readonly id?: string;
  readonly sessionId?: string;
  readonly mainlineId?: string;
  readonly locator?: ConversationSessionLocator;
  readonly workspaceId?: string;
  readonly metadata?: unknown;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}

export interface AcceptNormalizedEventInput {
  readonly id?: string | undefined;
  readonly lineEventId?: string | undefined;
  readonly sessionId: string;
  readonly targetLineId?: string | undefined;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: string;
  readonly conversationId: string;
  readonly sourceEventId: string;
  readonly sourceMessageId?: string | undefined;
  readonly sourceEventType: string;
  readonly senderId: string;
  readonly text: string;
  readonly message?: SynapseMessage | undefined;
  readonly segments?: readonly MessageSegment[] | undefined;
  readonly triggerHint?: ChannelTriggerHint | undefined;
  readonly rawPayload?: unknown;
  readonly receivedAt: string;
  readonly idempotencyKey: string;
  readonly lineEventType?: LineEventType | undefined;
  readonly actorId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly sessionMetadata?: unknown;
}

export interface AcceptedNormalizedEvent {
  readonly event: NormalizedEvent;
  readonly lineEvent: LineEvent;
  readonly session: ConversationSession;
  readonly mainline: ConversationMainline;
  readonly created: boolean;
}

export interface CreateBranchInput {
  readonly id?: string;
  readonly sessionId: string;
  readonly parentMainlineId?: string;
  readonly sourceEventId: string;
  readonly title: string;
  readonly goal: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly contextSnapshot?: unknown;
  readonly createdAt?: string;
}

export interface AppendLineEventInput {
  readonly id?: string;
  readonly sessionId?: string;
  readonly type: LineEventType;
  readonly idempotencyKey: string;
  readonly sourceNormalizedEventId?: string;
  readonly sourceEventId?: string;
  readonly causationEventId?: string;
  readonly correlationId?: string;
  readonly taskId?: string;
  readonly actorId?: string;
  readonly payload?: unknown;
  readonly createdAt?: string;
}

export interface TransitionSessionInput {
  readonly status: SessionStatus;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface TransitionBranchInput {
  readonly status: BranchStatus;
  readonly idempotencyKey: string;
  readonly payload?: unknown;
  readonly createdAt?: string;
}

export interface CreateTaskInput {
  readonly id?: string;
  readonly executor: string;
  readonly workspaceId?: string;
  readonly input: unknown;
  readonly artifacts?: readonly unknown[];
  readonly sourceEventId?: string;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface TransitionTaskInput {
  readonly status: TaskStatus;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly artifacts?: readonly unknown[];
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface CreateBranchResultInput {
  readonly id?: string;
  readonly version?: number;
  readonly status: BranchResultStatus;
  readonly summary: string;
  readonly artifacts?: readonly unknown[];
  readonly citations?: readonly unknown[];
  readonly nextActions?: readonly string[];
  readonly sourceTaskIds?: readonly string[];
  readonly sourceEventId?: string;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface MergeBranchResultInput {
  readonly resultId?: string;
  readonly id?: string;
  readonly eventId?: string;
  readonly branchEventId?: string;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}

/**
 * 创建语义节点时使用的输入
 */
export interface CreateConversationNodeInput {
  readonly id?: string;
  readonly parentIds?: readonly string[];
  readonly kind: ConversationNodeKind;
  readonly title: string;
  readonly statePatch: ConversationStatePatch;
  readonly sourceEventIds?: readonly string[];
  readonly sourceTaskIds?: readonly string[];
  readonly sourceResultIds?: readonly string[];
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

/**
 * 创建上下文检查点时使用的输入
 */
export interface CreateConversationContextSnapshotInput {
  readonly id?: string;
  readonly nodeId?: string;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

/**
 * 查询语义节点时使用的筛选条件
 */
export interface ListConversationNodesOptions {
  readonly limit?: number;
  readonly afterOrdinal?: number;
  readonly beforeOrdinal?: number;
  readonly kinds?: readonly ConversationNodeKind[];
}

export interface ListLinesOptions {
  readonly kind?: ConversationLine["kind"];
  readonly statuses?: readonly (MainlineStatus | BranchStatus)[];
}

export interface ListLineEventsOptions {
  readonly limit?: number;
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly types?: readonly LineEventType[];
}

export interface ListBranchesOptions {
  readonly statuses?: readonly BranchStatus[];
}

export interface ListTasksOptions {
  readonly statuses?: readonly TaskStatus[];
}

export interface BranchContext {
  readonly session: ConversationSession;
  readonly mainline: ConversationMainline;
  readonly branch: ConversationBranch;
  readonly sourceEvent: LineEvent;
  readonly contextSnapshot?: unknown;
  readonly events: readonly LineEvent[];
  readonly tasks: readonly ConversationTask[];
  readonly results: readonly BranchResult[];
}

export interface ConversationRecoveryState {
  readonly sessions: readonly ConversationSession[];
  readonly mainlines: readonly ConversationMainline[];
  readonly activeBranches: readonly ConversationBranch[];
  readonly unfinishedTasks: readonly ConversationTask[];
  readonly unmergedResults: readonly BranchResult[];
}

export interface TaskTrace {
  readonly task: ConversationTask;
  readonly branch: ConversationBranch;
  readonly mainline: ConversationMainline;
  readonly session: ConversationSession;
  readonly sourceEvent?: LineEvent;
  readonly branchSourceEvent: LineEvent;
  readonly events: readonly LineEvent[];
  readonly results: readonly BranchResult[];
}

export interface EventTrace {
  readonly event: LineEvent;
  readonly line: ConversationLine;
  readonly session: ConversationSession;
  readonly branch?: ConversationBranch;
  readonly task?: ConversationTask;
  readonly sourceEvent?: LineEvent;
  readonly causationChain: readonly LineEvent[];
  readonly relatedEvents: readonly LineEvent[];
}

export interface BranchResultTrace {
  readonly result: BranchResult;
  readonly branch: ConversationBranch;
  readonly mainline: ConversationMainline;
  readonly session: ConversationSession;
  readonly sourceEvent?: LineEvent;
  readonly tasks: readonly ConversationTask[];
  readonly merge?: BranchMerge;
  readonly mainlineEvent?: LineEvent;
}

export type ConversationStoreErrorCode =
  | "not_found"
  | "validation_error"
  | "conflict"
  | "idempotency_conflict"
  | "ownership_mismatch"
  | "invalid_state_transition";

export class ConversationStoreError extends Error {
  readonly code: ConversationStoreErrorCode;

  constructor(code: ConversationStoreErrorCode, message: string) {
    super(message);
    this.name = "ConversationStoreError";
    this.code = code;
  }
}

export interface ConversationStore {
  acceptNormalizedEvent(input: AcceptNormalizedEventInput): Promise<AcceptedNormalizedEvent>;
  getNormalizedEvent(eventId: string): Promise<NormalizedEvent | undefined>;
  listNormalizedEvents(sessionId: string): Promise<readonly NormalizedEvent[]>;

  createSession(input: CreateSessionInput): Promise<ConversationSession>;
  ensureSession(input: CreateSessionInput): Promise<ConversationSession>;
  getSession(sessionId: string): Promise<ConversationSession | undefined>;
  transitionSession(sessionId: string, input: TransitionSessionInput): Promise<ConversationSession>;

  getLine(lineId: string): Promise<ConversationLine | undefined>;
  getMainline(sessionId: string): Promise<ConversationMainline>;
  listLines(sessionId: string, options?: ListLinesOptions): Promise<readonly ConversationLine[]>;

  createBranch(input: CreateBranchInput): Promise<ConversationBranch>;
  getBranch(branchId: string): Promise<ConversationBranch | undefined>;
  listBranches(sessionId: string, options?: ListBranchesOptions): Promise<readonly ConversationBranch[]>;
  transitionBranch(branchId: string, input: TransitionBranchInput): Promise<ConversationBranch>;

  appendEvent(lineId: string, input: AppendLineEventInput): Promise<LineEvent>;
  getEvent(eventId: string): Promise<LineEvent | undefined>;
  listEvents(lineId: string, options?: ListLineEventsOptions): Promise<readonly LineEvent[]>;

  createTask(branchId: string, input: CreateTaskInput): Promise<ConversationTask>;
  getTask(taskId: string): Promise<ConversationTask | undefined>;
  listTasks(branchId: string, options?: ListTasksOptions): Promise<readonly ConversationTask[]>;
  transitionTask(taskId: string, input: TransitionTaskInput): Promise<ConversationTask>;

  createBranchResult(branchId: string, input: CreateBranchResultInput): Promise<BranchResult>;
  getBranchResult(resultId: string): Promise<BranchResult | undefined>;
  listBranchResults(branchId: string): Promise<readonly BranchResult[]>;
  mergeBranchResult(branchId: string, mainlineId: string, input?: MergeBranchResultInput): Promise<BranchMerge>;

  createNode(lineId: string, input: CreateConversationNodeInput): Promise<ConversationNode>;
  getNode(nodeId: string): Promise<ConversationNode | undefined>;
  listNodes(lineId: string, options?: ListConversationNodesOptions): Promise<readonly ConversationNode[]>;
  getLineHead(lineId: string): Promise<ConversationLineHead | undefined>;
  createContextSnapshot(
    lineId: string,
    input: CreateConversationContextSnapshotInput
  ): Promise<ConversationContextSnapshot>;
  getLatestContextSnapshot(lineId: string): Promise<ConversationContextSnapshot | undefined>;
  reconstructLineState(lineId: string, headNodeId?: string): Promise<ReconstructedConversationState>;

  getBranchContext(branchId: string): Promise<BranchContext>;
  getRecoveryState(sessionId?: string): Promise<ConversationRecoveryState>;
  getTaskTrace(taskId: string): Promise<TaskTrace>;
  getEventTrace(eventId: string): Promise<EventTrace>;
  getBranchResultTrace(resultId: string): Promise<BranchResultTrace>;
}
