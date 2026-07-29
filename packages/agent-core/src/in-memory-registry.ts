import type { Agent, AgentRegistry } from "./types.js";

/**
 * 智能体注册表的内存实现
 */
export class InMemoryAgentRegistry implements AgentRegistry {
  readonly #agents = new Map<string, Agent>();

  /** 注册智能体 */
  register(agent: Agent): void {
    if (this.#agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered.`);
    }

    this.#agents.set(agent.id, agent);
  }

  /** 按标识读取智能体 */
  get(agentId: string): Agent | undefined {
    return this.#agents.get(agentId);
  }

  /** 列出全部智能体 */
  list(): readonly Agent[] {
    return [...this.#agents.values()];
  }
}
