/** 管理协议中的运行状态，与服务端通过契约测试对齐 */
export type RunStatus = "accepted" | "running" | "succeeded" | "failed" | "blocked" | "uncertain" | "interrupted";
/** 浏览器可消费的逻辑运行投影，不依赖服务端包 */
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
  readonly error?: { readonly code: string; readonly message: string; readonly phase: string };
}
/** 持久事件的公开数据，未知扩展类型仍可在详情中检查 */
export interface RunEvent {
  readonly id: string;
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly cursor: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly attemptId?: string;
  readonly durationMs?: number;
  readonly data: unknown;
}
/** 运行查询过滤与分页参数 */
export interface RunQuery {
  readonly status?: RunStatus;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly before?: number;
  readonly limit?: number;
}
/** 运行列表的有界响应 */
export interface RunListResponse {
  readonly ok: true;
  readonly protocolVersion: 1;
  readonly items: readonly RunTrace[];
  readonly nextCursor?: number;
}
/** 单 Run 增量事件响应 */
export interface RunEventsResponse {
  readonly ok: true;
  readonly events: readonly RunEvent[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
/** 订阅初始快照，cursor 表示本次历史补读的起点 */
export interface RunSnapshot {
  readonly protocolVersion: 1;
  readonly cursor: number;
  readonly highWaterMark: number;
  readonly runs: readonly RunTrace[];
}
/** 持久流连接状态，认证错误不无限重试 */
export type RunStreamState = "connecting" | "connected" | "reconnecting" | "unauthorized" | "stopped";
/** 订阅观察器，回调成功后才推进本地补读游标 */
export interface RunStreamOptions {
  readonly afterCursor?: number;
  readonly onEvent: (event: RunEvent) => void;
  readonly onSnapshot?: (snapshot: RunSnapshot) => void;
  readonly onState?: (state: RunStreamState) => void;
  readonly onError?: (error: Error) => void;
  readonly onReset?: () => void;
}
/** 会话及数据浏览的分页响应 */
export interface InspectionPage {
  readonly ok: true;
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor?: string | number | null;
}
