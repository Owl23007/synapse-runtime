import type { AgentRequest } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { RuntimeEventScope } from "../runtime/types.js";

/** 宿主签发的工作区授权，后台工作继承主体且不能扩大通知目标 */
export interface ExecutionGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId?: string;
  readonly source: AgentRequest["source"];
  readonly expiresAt: number;
  readonly revoked: boolean;
}

/** 可多次推进的持久目标，与 executor 作业和 Run 终态独立 */
export interface Task {
  /** 创建任务的会话线路，分支恢复时不混入主线目标 */
  readonly lineId?: string;
  /** 创建会话仅用于上下文相关性和幂等隔离，授权仍由工作区与主体决定 */
  readonly sessionId?: string;
  /** 完成本次目标修订的运行，用于允许其结束交付而不复活其他旧运行 */
  readonly completedByRunId?: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly goal: string;
  readonly acceptance: string;
  readonly status: "open" | "paused" | "completed" | "cancelled";
  readonly revision: number;
  readonly parentId?: string;
  readonly progress: string;
  readonly results: readonly { readonly runId: string; readonly revision: number; readonly content: string }[];
}

/** 明确的未来时间规则，固定间隔按 UTC 实际时间，日历规则按 IANA 时区 */
export type ScheduleRule =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "interval"; readonly startAt: number; readonly everyMs: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number; readonly timezone: string };

/** 时间计划独立于会话和任务，修订后未执行的旧 occurrence 失效 */
export interface Schedule {
  /** 授权总量耗尽时停止生成新 occurrence，已接受工作仍可完成 */
  readonly stopReason?: "grant_budget";
  readonly id: string;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly rule: ScheduleRule;
  readonly instruction: string;
  readonly mode: "agent" | "reminder";
  readonly status: "active" | "paused" | "completed" | "cancelled";
  readonly revision: number;
  readonly nextFireAt: number;
  readonly expiresAt: number;
  readonly maxOccurrences: number;
  readonly fired: number;
  readonly missed: "skip" | "coalesce";
  readonly overlap: "skip" | "queue";
}

/** 接受后可以跨进程恢复的执行请求，不携带可由模型伪造的授权 */
export interface ExecutionIntent {
  readonly id: string;
  readonly runId: string;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly taskRevision?: number;
  readonly scheduleId?: string;
  readonly scheduleRevision?: number;
  readonly state: "queued" | "claimed" | "done" | "blocked";
  readonly attempts: number;
  /** 持久退避到期前，即使手动派发也不能建立新 Attempt */
  readonly availableAt: number;
  readonly createdAt: number;
  readonly payload: {
    readonly request: AgentRequest;
    readonly event: SynapseChannelEvent;
    readonly scope?: RuntimeEventScope;
    readonly reminder?: string;
    readonly deliveryOfRunId?: string;
  };
}

/** 执行结果与发送意图正交，等待结束当前推理机会并由未来事件继续 */
export type OutputIntent =
  | { readonly kind: "silent" }
  | { readonly kind: "waiting"; readonly scheduleId: string }
  | { readonly kind: "reply"; readonly message: SynapseMessage }
  | { readonly kind: "notify"; readonly message: SynapseMessage };
