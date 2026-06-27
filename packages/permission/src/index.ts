export type PermissionPolicy = "allow" | "confirm" | "deny" | "sandbox" | "rate_limit";

export interface PermissionRequest {
  readonly action: string;
  readonly resource: string;
  readonly subject?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PermissionDecision {
  readonly action: string;
  readonly resource: string;
  readonly decision: PermissionPolicy;
  readonly reason?: string;
}

export interface PermissionEngine {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export class StaticPermissionEngine implements PermissionEngine {
  readonly #policies: Readonly<Record<string, PermissionPolicy>>;
  readonly #fallback: PermissionPolicy;

  constructor(policies: Readonly<Record<string, PermissionPolicy>>, fallback: PermissionPolicy = "deny") {
    this.#policies = policies;
    this.#fallback = fallback;
  }

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
