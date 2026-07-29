import { randomUUID } from "node:crypto";
import type { PermissionDecision, PermissionEngine, PermissionRequest } from "@synapse/runtime-permission";
import { ToolCallRecoveryError } from "./errors.js";
import type {
  ScopedToolCallContext,
  ScopedToolRuntimeView,
  Tool,
  ToolCallContext,
  ToolCallReplayResolver,
  ToolCallResult,
  ToolContext,
  ToolRuntimeEvent,
  ToolRuntimeObserver,
  ToolRuntimeScope,
  ToolRuntimeView
} from "./types.js";

/**
 * 管理工具注册、权限判断、调用与恢复观察
 */
export class ToolRuntime implements ToolRuntimeView {
  readonly #tools = new Map<string, Tool>();
  readonly #permissionEngine: PermissionEngine;
  readonly #observers = new Map<number, ToolRuntimeObserver>();
  #observerSequence = 0;

  /** 创建工具运行时 */
  constructor(permissionEngine: PermissionEngine) {
    this.#permissionEngine = permissionEngine;
  }

  /** 注册工具 */
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }

    this.#tools.set(tool.name, tool);
  }

  /** 列出已注册工具 */
  list(): readonly Tool[] {
    return [...this.#tools.values()];
  }

  /** 注册工具运行事件观察器 */
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

  /** 创建绑定会话与恢复上下文的工具视图 */
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

  /** 判断外部动作权限 */
  async decidePermission(request: PermissionRequest): Promise<PermissionDecision> {
    return this.#permissionEngine.decide(request);
  }

  /** 调用指定工具 */
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
      const permission = typeof tool.permission === "function" ? tool.permission(input, callContext) : tool.permission;
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
