import type { AgentRequest } from "@synapse/runtime-conversation";
import type { SynapseMessage } from "@synapse/runtime-protocol";
import type { ScopedToolRuntimeView } from "@synapse/runtime-tool-runtime";

export type AgentRunStatus = "queued" | "running" | "waiting_confirm" | "succeeded" | "failed";

export interface AgentStep {
  readonly id: string;
  readonly kind: "model" | "tool" | "system";
  readonly status: "running" | "succeeded" | "failed" | "blocked";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
}

export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly status: AgentRunStatus;
  readonly input: SynapseMessage;
  readonly steps: readonly AgentStep[];
  readonly output?: SynapseMessage;
  readonly error?: string;
}

/** 运行时绑定的身份、工具与模型观察入口 */
export interface AgentRuntimeContext {
  /** 逻辑运行标识由宿主决定，恢复时保持不变 */
  readonly runId?: string;
  /** 观察回调完成后才允许继续执行，持久化失败应停止调用链 */
  readonly observeModel?: (event: AgentModelEvent) => void | Promise<void>;
  readonly tools: ScopedToolRuntimeView;
  readonly conversation: AgentConversationRuntime;
}

/** 单轮模型请求与结果事件，不包含 Provider 凭据或 HTTP Header */
export interface AgentModelEvent {
  readonly type: "model_call_started" | "model_call_succeeded" | "model_call_failed";
  readonly modelCallId: string;
  readonly providerId: string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly data: unknown;
}

export interface AgentBranchCreateInput {
  readonly title: string;
  readonly goal: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly contextSnapshot?: unknown;
}

export interface AgentBranchRef {
  readonly id: string;
  readonly sessionId: string;
  readonly parentMainlineId: string;
  readonly sourceEventId: string;
  readonly status: string;
}

export interface AgentConversationRuntime {
  /** 创建与当前主线隔离的会话分支 */
  createBranch(input: AgentBranchCreateInput): Promise<AgentBranchRef>;
}

export interface Agent {
  readonly id: string;
  /** 执行一次智能体运行 */
  run(request: AgentRequest, context: AgentRuntimeContext): Promise<AgentRun>;
}

export interface AgentRegistry {
  /** 注册智能体 */
  register(agent: Agent): void;
  /** 按标识读取智能体 */
  get(agentId: string): Agent | undefined;
  /** 列出全部智能体 */
  list(): readonly Agent[];
}
