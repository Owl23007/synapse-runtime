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
  /** 判断权限请求应采用的策略 */
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}
