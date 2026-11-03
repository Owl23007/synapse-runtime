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
export type BranchResultStatus = "completed" | "failed" | "cancelled";

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
  | "branch_result_published"
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

/** 用于会话呈现的显式分支产出，独立于持久目标和上下文版本 */
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
  readonly idempotencyKey: string;
  readonly sourceEventId?: string;
  readonly createdAt: string;
}

/** 分支产出显式发布到主线后的事实引用 */
export interface BranchPublication {
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

export interface CreateBranchResultInput {
  readonly id?: string;
  readonly version?: number;
  readonly status: BranchResultStatus;
  readonly summary: string;
  readonly artifacts?: readonly unknown[];
  readonly citations?: readonly unknown[];
  readonly nextActions?: readonly string[];
  readonly sourceEventId?: string;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

/** 发布既有分支产出的幂等请求 */
export interface PublishBranchResultInput {
  readonly resultId?: string;
  readonly id?: string;
  readonly eventId?: string;
  readonly branchEventId?: string;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
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

/** 当前会话分支的呈现事实，不包含执行任务或第二套语义状态 */
export interface BranchContext {
  readonly session: ConversationSession;
  readonly mainline: ConversationMainline;
  readonly branch: ConversationBranch;
  readonly sourceEvent: LineEvent;
  readonly contextSnapshot?: unknown;
  readonly events: readonly LineEvent[];
  readonly results: readonly BranchResult[];
}

/** 活动会话与未发布产出的查询视图，不驱动模型执行 */
export interface ConversationRecoveryState {
  readonly sessions: readonly ConversationSession[];
  readonly mainlines: readonly ConversationMainline[];
  readonly activeBranches: readonly ConversationBranch[];
  readonly unmergedResults: readonly BranchResult[];
}

/** 会话事件的来源和因果关系 */
export interface EventTrace {
  readonly event: LineEvent;
  readonly line: ConversationLine;
  readonly session: ConversationSession;
  readonly branch?: ConversationBranch;
  readonly sourceEvent?: LineEvent;
  readonly causationChain: readonly LineEvent[];
  readonly relatedEvents: readonly LineEvent[];
}

/** 分支产出与显式发布事实的来源关系 */
export interface BranchResultTrace {
  readonly result: BranchResult;
  readonly branch: ConversationBranch;
  readonly mainline: ConversationMainline;
  readonly session: ConversationSession;
  readonly sourceEvent?: LineEvent;
  /**
   * 分支结果向主线发布后的引用
   */
  readonly publication?: BranchPublication;
  readonly mainlineEvent?: LineEvent;
}

export type ConversationStoreErrorCode =
  | "not_found"
  | "validation_error"
  | "conflict"
  | "idempotency_conflict"
  | "ownership_mismatch"
  | "invalid_state_transition";
