import { randomUUID } from "node:crypto";
import type {
  PermissionDecision,
  PermissionEngine,
  PermissionPolicy,
  PermissionRequest
} from "@synapse/runtime-permission";

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

/**
 * 根据输入和运行上下文动态生成权限要求
 */
export type ToolPermissionResolver<TInput = unknown> = (
  input: TInput,
  context: ToolContext
) => PermissionRequirement;

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  /** 发送给模型并用于参数校验的 JSON Schema */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** 固定权限要求或根据本次调用动态生成的权限要求 */
  readonly permission: PermissionRequirement | ToolPermissionResolver<TInput>;
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

export class ToolCallRecoveryError extends Error {
  readonly code: ToolCallRecoveryErrorCode;
  readonly detail?: unknown;

  constructor(code: ToolCallRecoveryErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ToolCallRecoveryError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ToolRuntimeView {
  list(): readonly Tool[];
  decidePermission(request: PermissionRequest): Promise<PermissionDecision>;
  call<TOutput = unknown>(name: string, input: unknown, context: ToolContext): Promise<ToolCallResult<TOutput>>;
}

export type ScopedToolCallContext = Pick<ToolContext, "runId"> & Partial<Pick<ToolContext, "callId">>;

export interface ScopedToolRuntimeView {
  list(): readonly Tool[];
  decidePermission(request: PermissionRequest): Promise<PermissionDecision>;
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
  | (ToolRuntimeEventBase & {
      readonly type: "tool_call_started";
    })
  | (ToolRuntimeEventBase & {
      readonly type: "tool_call_blocked";
      readonly reason: string;
    })
  | (ToolRuntimeEventBase & {
      readonly type: "tool_call_succeeded";
      readonly output: unknown;
    })
  | (ToolRuntimeEventBase & {
      readonly type: "tool_call_failed";
      readonly error: unknown;
    });

export type ToolRuntimeObserver = (event: ToolRuntimeEvent) => void | Promise<void>;

export class ToolRuntime implements ToolRuntimeView {
  readonly #tools = new Map<string, Tool>();
  readonly #permissionEngine: PermissionEngine;
  readonly #observers = new Map<number, ToolRuntimeObserver>();
  #observerSequence = 0;

  constructor(permissionEngine: PermissionEngine) {
    this.#permissionEngine = permissionEngine;
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }

    this.#tools.set(tool.name, tool);
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  addObserver(observer: ToolRuntimeObserver): () => void {
    const observerId = ++this.#observerSequence;
    this.#observers.set(observerId, observer);
    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      this.#observers.delete(observerId);
    };
  }

  withContext(defaults: ToolRuntimeScope): ScopedToolRuntimeView {
    const { durableCallIdPrefix, replayCall, ...bound } = defaults;
    let callSequence = 0;
    let haltedReason: string | undefined;
    let pendingCall: Promise<void> = Promise.resolve();
    return {
      list: () => this.list(),
      decidePermission: (request) => this.decidePermission(request),
      call: async <TOutput = unknown>(name: string, input: unknown, context: ScopedToolCallContext) => {
        callSequence += 1;
        const sequence = callSequence;
        const callId =
          durableCallIdPrefix === undefined ? context.callId : `tool-call:${durableCallIdPrefix}:${sequence}`;
        const execute = async () => {
          if (haltedReason !== undefined) {
            throw new ToolCallRecoveryError(
              "scope_halted",
              `Tool execution is halted for this agent run because ${haltedReason}`
            );
          }

          try {
            return await this.#call<TOutput>(
              name,
              input,
              {
                runId: context.runId,
                ...bound,
                ...(callId === undefined ? {} : { callId })
              },
              replayCall
            );
          } catch (error) {
            haltedReason =
              error instanceof ToolCallRecoveryError
                ? error.message
                : "a previous tool call failed or its durable result could not be confirmed.";
            throw error;
          }
        };
        const result = pendingCall.then(execute);
        pendingCall = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      }
    };
  }

  async decidePermission(request: PermissionRequest): Promise<PermissionDecision> {
    return this.#permissionEngine.decide(request);
  }

  async call<TOutput = unknown>(name: string, input: unknown, context: ToolContext): Promise<ToolCallResult<TOutput>> {
    return this.#call(name, input, context);
  }

  async #call<TOutput = unknown>(
    name: string,
    input: unknown,
    context: ToolContext,
    replayCall?: ToolCallReplayResolver
  ): Promise<ToolCallResult<TOutput>> {
    const callContext: ToolCallContext = {
      ...context,
      callId: context.callId ?? `tool-call-${randomUUID()}`
    };
    if (replayCall !== undefined) {
      const replay = await replayCall({ name, input, context: callContext });
      switch (replay.status) {
        case "succeeded":
          return { status: "succeeded", output: replay.output as TOutput };
        case "blocked":
          return { status: "blocked", reason: replay.reason };
        case "failed":
          throw new ToolCallRecoveryError(
            "replayed_failure",
            `Tool call "${callContext.callId}" previously failed and was not executed again.`,
            replay.error
          );
        case "started":
          throw new ToolCallRecoveryError(
            "outcome_uncertain",
            `Tool call "${callContext.callId}" started previously, but its durable result is unknown; it was not executed again.`
          );
        case "conflict":
          throw new ToolCallRecoveryError("idempotency_conflict", replay.reason);
        case "missing":
          break;
      }
    }
    await this.#notify({
      type: "tool_call_started",
      name,
      input,
      context: callContext,
      occurredAt: new Date().toISOString()
    });

    const tool = this.#tools.get(name);

    if (tool === undefined) {
      return this.#fail(name, input, callContext, new Error(`Tool "${name}" is not registered.`));
    }

    let decision: PermissionDecision;
    try {
      const permission =
        typeof tool.permission === "function" ? tool.permission(input, callContext) : tool.permission;
      decision = await this.#permissionEngine.decide({
        action: permission.action,
        resource: permission.resource,
        subject: callContext.userId
      });
    } catch (error) {
      return this.#fail(name, input, callContext, error);
    }

    if (decision.decision !== "allow") {
      const reason = decision.reason ?? `Permission decision was "${decision.decision}".`;
      await this.#notify({
        type: "tool_call_blocked",
        name,
        input,
        reason,
        context: callContext,
        occurredAt: new Date().toISOString()
      });
      return {
        status: "blocked",
        reason
      };
    }

    let output: TOutput;
    try {
      output = (await tool.handle(input, callContext)) as TOutput;
    } catch (error) {
      return this.#fail(name, input, callContext, error);
    }

    await this.#notify({
      type: "tool_call_succeeded",
      name,
      input,
      output,
      context: callContext,
      occurredAt: new Date().toISOString()
    });

    return {
      status: "succeeded",
      output
    };
  }

  async #fail(name: string, input: unknown, context: ToolCallContext, error: unknown): Promise<never> {
    try {
      await this.#notify({
        type: "tool_call_failed",
        name,
        input,
        error,
        context,
        occurredAt: new Date().toISOString()
      });
    } catch {
      // Preserve the tool or permission failure promised to the caller.
    }

    throw error;
  }

  async #notify(event: ToolRuntimeEvent): Promise<void> {
    const observers = [...this.#observers.values()];
    await observers.reduce<Promise<void>>(
      (pending, observer) => pending.then(() => observer(event)),
      Promise.resolve()
    );
  }
}
