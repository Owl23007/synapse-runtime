/** 逻辑运行状态，未知外部结果不能视为普通失败重试 */
export type RunStatus = "accepted" | "running" | "succeeded" | "failed" | "blocked" | "uncertain" | "interrupted";

/** 运行事件类型，日志不参与该持久协议 */
export type RunEventType =
  | "asset_materialized"
  | "skill_activated"
  | "dependencies_resolved"
  | "run_accepted"
  | "run_started"
  | "run_resumed"
  | "run_succeeded"
  | "run_failed"
  | "run_blocked"
  | "run_uncertain"
  | "run_interrupted"
  | "context_resolved"
  | "context_committed"
  | "model_call_started"
  | "model_call_succeeded"
  | "model_call_failed"
  | "tool_call_started"
  | "tool_call_succeeded"
  | "tool_call_failed"
  | "tool_call_blocked"
  | "tool_call_replayed"
  | "permission_allowed"
  | "permission_blocked"
  | "artifact_created"
  | "artifact_selection_changed"
  | "artifact_upload_started"
  | "artifact_upload_succeeded"
  | "artifact_upload_failed"
  | "artifact_upload_uncertain"
  | "response_sending"
  | "response_sent"
  | "response_send_failed"
  | "response_send_uncertain";

/** 可公开展示的脱敏错误 */
export interface RunError {
  readonly code: string;
  readonly message: string;
  readonly phase: string;
}

/** 稳定的逻辑运行，不随 Agent 或恢复尝试重新分配身份 */
export interface RunTrace {
  readonly id: string;
  readonly protocolVersion: 1;
  readonly sourceEventId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly lineId?: string;
  readonly branchId?: string;
  readonly status: RunStatus;
  readonly phase: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly summary: string;
  readonly lastSeq: number;
  readonly error?: RunError;
}

/** 已提交的事件，全局游标与单 Run 序号分别使用 */
export interface RunEvent {
  readonly id: string;
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly cursor: number;
  readonly type: RunEventType;
  readonly occurredAt: string;
  readonly attemptId?: string;
  readonly durationMs?: number;
  readonly data: unknown;
}

/** 接受请求所需的持久身份与展示摘要 */
export interface AcceptRunInput {
  readonly sourceEventId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly lineId?: string;
  readonly branchId?: string;
  readonly summary: string;
}

/** 单次追加及其投影变更，在同一事务中提交 */
export interface AppendRunEventInput {
  readonly key: string;
  readonly type: RunEventType;
  readonly attemptId?: string;
  readonly durationMs?: number;
  readonly data?: unknown;
  readonly status?: RunStatus;
  readonly phase?: string;
  readonly error?: RunError;
}

/** 有界运行列表过滤，before 使用上一页末项的稳定游标 */
export interface ListRunsInput {
  readonly limit?: number;
  readonly before?: number;
  readonly status?: RunStatus;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly since?: string;
  readonly until?: string;
}

/** 运行查询分页结果 */
export interface RunPage {
  readonly items: readonly RunTrace[];
  readonly nextCursor?: number;
}

/** 同步持久写入边界，调用返回后才允许执行依赖它的副作用 */
export interface RunTraceStore {
  /** 幂等接受规范化事件 */
  accept(input: AcceptRunInput): RunTrace;
  /** 原子追加事件与更新运行状态 */
  append(runId: string, input: AppendRunEventInput): RunEvent;
  /** 读取指定运行 */
  get(runId: string): RunTrace | undefined;
  /** 按接受顺序倒序分页 */
  list(input?: ListRunsInput): RunPage;
  /** 读取单次运行的有界增量 */
  events(runId: string, afterSeq?: number, limit?: number): readonly RunEvent[];
  /** 查询最近一次指定类型的事实，避免详情接口读取全部事件 */
  latestEvent(runId: string, type: RunEventType): RunEvent | undefined;
  /** 读取跨运行的持久事件流 */
  stream(afterCursor?: number, limit?: number): readonly RunEvent[];
  /** 获取当前持久流高水位 */
  highWaterMark(): number;
  /** 启动时关闭遗留活动记录，禁止盲目重放未决副作用 */
  recover(): void;
}

/** 只读外部持久回执核对输入，目标来源于已接受的规范化事件 */
export interface RecoverToolOutputInput {
  readonly sessionId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly name: string;
  readonly input: unknown;
}

/** 仅返回已存在的工具输出，找不到可靠回执时不得推测成功 */
export type RecoverToolOutput = (input: RecoverToolOutputInput) => Readonly<Record<string, unknown>> | undefined;
