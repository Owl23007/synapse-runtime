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

export interface AgentRuntimeContext {
  readonly tools: ScopedToolRuntimeView;
  readonly conversation: AgentConversationRuntime;
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
