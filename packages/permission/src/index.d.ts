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
export declare class StaticPermissionEngine implements PermissionEngine {
    #private;
    constructor(policies: Readonly<Record<string, PermissionPolicy>>, fallback?: PermissionPolicy);
    decide(request: PermissionRequest): Promise<PermissionDecision>;
}
//# sourceMappingURL=index.d.ts.map