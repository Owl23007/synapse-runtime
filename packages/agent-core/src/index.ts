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
  createBranch(input: AgentBranchCreateInput): Promise<AgentBranchRef>;
}

export interface Agent {
  readonly id: string;
  run(request: AgentRequest, context: AgentRuntimeContext): Promise<AgentRun>;
}

export interface AgentRegistry {
  register(agent: Agent): void;
  get(agentId: string): Agent | undefined;
  list(): readonly Agent[];
}

export class InMemoryAgentRegistry implements AgentRegistry {
  readonly #agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.#agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered.`);
    }

    this.#agents.set(agent.id, agent);
  }

  get(agentId: string): Agent | undefined {
    return this.#agents.get(agentId);
  }

  list(): readonly Agent[] {
    return [...this.#agents.values()];
  }
}
