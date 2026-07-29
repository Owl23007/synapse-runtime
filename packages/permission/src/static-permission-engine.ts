import type { PermissionDecision, PermissionEngine, PermissionPolicy, PermissionRequest } from "./types.js";

/**
 * 使用静态动作策略表进行权限判断
 */
export class StaticPermissionEngine implements PermissionEngine {
  readonly #policies: Readonly<Record<string, PermissionPolicy>>;
  readonly #fallback: PermissionPolicy;

  /**
   * 创建静态权限引擎
   */
  constructor(policies: Readonly<Record<string, PermissionPolicy>>, fallback: PermissionPolicy = "deny") {
    this.#policies = policies;
    this.#fallback = fallback;
  }

  /**
   * 返回动作对应的权限决策
   */
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = this.#policies[request.action] ?? this.#fallback;

    return {
      action: request.action,
      resource: request.resource,
      decision,
      ...(decision === this.#fallback && this.#policies[request.action] === undefined
        ? { reason: "No explicit policy matched this action." }
        : {})
    };
  }
}
