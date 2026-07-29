import type { PermissionDecision, PermissionPolicy, PermissionRequest } from "@synapse/runtime-permission";

export interface PermissionRequirement {
  readonly action: string;
  readonly resource: string;
  readonly defaultPolicy?: PermissionPolicy;
}

export interface ToolContext {
  readonly runId: string;
  readonly attemptId?: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly lineId?: string;
  readonly branchId?: string;
  readonly taskId?: string;
  readonly causationEventId?: string;
  readonly callId?: string;
}

export type ToolCallContext = ToolContext & { readonly callId: string };

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolContext
) => Promise<TOutput>;

/** 根据输入和运行上下文动态生成权限要求 */
export type ToolPermissionResolver<TInput = unknown> = (input: TInput, context: ToolContext) => PermissionRequirement;

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  /** 发送给模型并用于参数校验的 JSON Schema */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** 固定权限要求或根据本次调用动态生成的权限要求 */
  readonly permission: PermissionRequirement | ToolPermissionResolver<TInput>;
  /** 执行工具调用 */
  handle(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolCallResult<TOutput = unknown> {
  readonly status: "succeeded" | "blocked";
  readonly output?: TOutput;
  readonly reason?: string;
}

export interface ToolCallReplayRequest {
  readonly name: string;
  readonly input: unknown;
  readonly context: ToolCallContext;
}

export type ToolCallReplayResolution =
  | { readonly status: "missing" }
  | { readonly status: "started" }
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "failed"; readonly error?: unknown }
  | { readonly status: "conflict"; readonly reason: string };

export type ToolCallReplayResolver = (request: ToolCallReplayRequest) => Promise<ToolCallReplayResolution>;

export type ToolCallRecoveryErrorCode =
  | "outcome_uncertain"
  | "replayed_failure"
  | "idempotency_conflict"
  | "scope_halted";

export interface ToolRuntimeView {
  /** 列出已注册工具 */
  list(): readonly Tool[];
  /** 判断工具外部动作权限 */
  decidePermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** 调用指定工具 */
  call<TOutput = unknown>(name: string, input: unknown, context: ToolContext): Promise<ToolCallResult<TOutput>>;
}

export type ScopedToolCallContext = Pick<ToolContext, "runId"> & Partial<Pick<ToolContext, "callId">>;

export interface ScopedToolRuntimeView {
  /** 列出已注册工具 */
  list(): readonly Tool[];
  /** 判断工具外部动作权限 */
  decidePermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** 使用绑定上下文调用指定工具 */
  call<TOutput = unknown>(
    name: string,
    input: unknown,
    context: ScopedToolCallContext
  ): Promise<ToolCallResult<TOutput>>;
}

export interface ToolRuntimeScope {
  readonly sessionId: string;
  readonly userId: string;
  readonly attemptId?: string;
  readonly lineId?: string;
  readonly branchId?: string;
  readonly taskId?: string;
  readonly causationEventId?: string;
  readonly durableCallIdPrefix?: string;
  readonly replayCall?: ToolCallReplayResolver;
}

interface ToolRuntimeEventBase {
  readonly name: string;
  readonly input: unknown;
  readonly context: ToolCallContext;
  readonly occurredAt: string;
}

export type ToolRuntimeEvent =
  | (ToolRuntimeEventBase & { readonly type: "tool_call_started" })
  | (ToolRuntimeEventBase & { readonly type: "tool_call_blocked"; readonly reason: string })
  | (ToolRuntimeEventBase & { readonly type: "tool_call_succeeded"; readonly output: unknown })
  | (ToolRuntimeEventBase & { readonly type: "tool_call_failed"; readonly error: unknown });

export type ToolRuntimeObserver = (event: ToolRuntimeEvent) => void | Promise<void>;
