import type { AgentRequest } from "@synapse/runtime-conversation";
import type { SynapseMessage } from "@synapse/runtime-protocol";
import type { ScopedToolRuntimeView } from "@synapse/runtime-tool-runtime";
import type { ModelFailure } from "./model-error.js";

export type AgentRunStatus = "queued" | "running" | "waiting_confirm" | "succeeded" | "failed";

export interface AgentStep {
  readonly id: string;
  readonly kind: "model" | "tool" | "system";
  readonly status: "running" | "succeeded" | "failed" | "blocked";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
}

/** 一次智能体执行的结果，工作完成和对外发送分别表达 */
export interface AgentRun {
  /** 失败分类由提供商或可信 Agent 报告，不根据错误文本猜测重试 */
  readonly failure?: ModelFailure;
  /** 工作结果不等于外部消息，静默和等待均可正常结束本次推理 */
  readonly outcome?: AgentOutcome;
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
  /** 原生会话可观察生成中的文本，外部频道继续使用最终交付语义 */
  readonly streamText?: boolean;
  /** 宿主全局请求预算覆盖提示词、候选、工具定义及后续工具结果 */
  readonly maxInputChars?: number;
  /** 由宿主持久化的结束意图，循环在工具安全边界读取 */
  readonly getOutcome?: () => AgentOutcome | undefined;
  /** 每次模型请求和副作用前消费持久补充信息并检查当前授权 */
  readonly checkpoint?: () => Promise<readonly { readonly id: number; readonly content: string }[]>;
  /** 下一模型请求已采用补充信息后确认消费 */
  readonly acknowledgeInputs?: (through: number) => void;
  /** 宿主运行截止或退出信号，取消后不得发起新的模型与工具动作 */
  readonly signal?: AbortSignal;
  /** 逻辑运行标识由宿主决定，恢复时保持不变 */
  readonly runId?: string;
  /** 观察回调完成后才允许继续执行，持久化失败应停止调用链 */
  readonly observeModel?: (event: AgentModelEvent) => void | Promise<void>;
  readonly tools: ScopedToolRuntimeView;
  readonly conversation: AgentConversationRuntime;
}

/** 与 Run 状态独立的结果表达，通知目标只能使用宿主绑定来源 */
export type AgentOutcome =
  | { readonly kind: "silent" }
  | { readonly kind: "waiting"; readonly scheduleId: string }
  | { readonly kind: "reply" | "notify"; readonly message: SynapseMessage };

/** 单轮模型请求与结果事件，不包含 Provider 凭据或 HTTP Header */
export interface AgentModelEvent {
  readonly type: "model_call_started" | "model_call_succeeded" | "model_call_failed" | "model_output";
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
