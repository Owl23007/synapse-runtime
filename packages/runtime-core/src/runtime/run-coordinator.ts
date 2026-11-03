import type { Agent, AgentRuntimeContext } from "@synapse/runtime-agent-core";
import { ModelProviderError, type ModelFailure } from "@synapse/runtime-agent-core";
import type { AgentRequest, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent } from "@synapse/runtime-protocol";
import {
  ToolCallRecoveryError,
  type ToolCallReplayRequest,
  type ToolCallReplayResolution,
  type ToolRuntime
} from "@synapse/runtime-tool-runtime";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildSourceEventId, type ConversationStore, type EventProcessStore } from "../context.js";
import { RunRecorder } from "../trace/recorder.js";
import type { RunTraceStore } from "../trace/types.js";
import { serializeError, stringifyAgentOutput } from "./event-records.js";
import { ExecutionGate, withAbort } from "./execution-budget.js";
import { getText, summarizeMessage } from "./message-utils.js";
import type { RuntimeCoreLogger, RuntimeCoreOptions, RuntimeEventScope } from "./types.js";
import type { ExecutionStore } from "../execution/store.js";
import type { ExecutionIntent } from "../execution/types.js";
import type { RuntimeDelivery } from "./delivery.js";
import { allocateContext, trustedContextCost } from "../context/budget.js";

interface CoordinatorOptions {
  readonly execution?: ExecutionStore | undefined;
  readonly maxContextChars?: number;
  readonly agent: Agent;
  readonly tools: ToolRuntime;
  readonly conversationStore: ConversationStore;
  readonly eventProcessStore: EventProcessStore;
  readonly runs: RunTraceStore | undefined;
  readonly logger: RuntimeCoreLogger | undefined;
  readonly limits: RuntimeCoreOptions["limits"];
}

/** 管理实例执行容量、运行预算、Agent 调度与终态收尾 */
export class RunCoordinator {
  /** 正在执行的运行取消信号，交付沿用同一个截止时间 */
  readonly controllers = new Map<string, AbortController>();
  /** 运行记录器按持久 Run 身份关联，恢复和交付使用同一投影 */
  readonly recorders = new Map<string, RunRecorder>();
  readonly #gate: ExecutionGate;
  readonly #runTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #operations = new Set<Promise<unknown>>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  /** 初始化预算，不启动运行或副作用 */
  constructor(private readonly options: CoordinatorOptions) {
    this.#gate = new ExecutionGate(options.limits?.maxConcurrent ?? 4, options.limits?.maxQueued ?? 64);
    this.#runTimeoutMs = options.limits?.runTimeoutMs ?? 300_000;
    this.#toolTimeoutMs = options.limits?.toolTimeoutMs ?? 130_000;
    this.#shutdownGraceMs = options.limits?.shutdownGraceMs ?? 30_000;
    for (const value of [this.#runTimeoutMs, this.#toolTimeoutMs, this.#shutdownGraceMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("运行时间预算无效");
  }

  /** 宿主关闭后拒绝新执行 */
  get disposed(): boolean {
    return this.#disposed;
  }
  /** 容量统计不把排队请求视为执行中 */
  get executionStatus() {
    return this.#gate.status;
  }

  /** 将入口执行纳入容量限制和关闭等待 */
  dispatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.track(this.#gate.run(operation));
  }

  /** 非 Agent 的会话写入也必须在资源释放前完成 */
  track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    const remove = () => this.#operations.delete(operation);
    void operation.then(remove, remove);
    return operation;
  }

  /** 同一进程内同一运行只能持有一个截止时间控制器 */
  beginRun(id: string) {
    if (this.controllers.has(id)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("运行已超过截止时间")), this.#runTimeoutMs);
    this.controllers.set(id, controller);
    return { controller, timer };
  }

  /** 持久 claim 成功后才开始记录运行尝试 */
  beginRecording(runId: string): RunRecorder | undefined {
    if (!this.options.runs) return undefined;
    const recorder = new RunRecorder(runId, this.options.runs);
    this.recorders.set(runId, recorder);
    return recorder;
  }

  /** 按原顺序结束预算、记录终态并清理进程内尝试 */
  finishRun(id: string, timer: ReturnType<typeof setTimeout>, recorder: RunRecorder | undefined): void {
    clearTimeout(timer);
    this.controllers.delete(id);
    if (recorder !== undefined) {
      try {
        recorder.finish();
      } catch {
        this.options.logger?.error("Run terminal state could not be persisted; recovery is required.", {
          runId: recorder.runId
        });
      }
      this.recorders.delete(recorder.runId);
    }
  }

  /** 关闭入口并排空执行，超过预算只取消进行中的运行而不伪造外部终态 */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#gate.close();
    const inFlight = [...this.#operations];
    this.#disposePromise = (async () => {
      const timer = setTimeout(() => {
        for (const controller of this.controllers.values()) controller.abort(new Error("Runtime 退出收尾超时"));
      }, this.#shutdownGraceMs);
      try {
        await Promise.allSettled(inFlight);
        const pending = await this.options.tools.drain();
        if (pending > 0) this.options.logger?.warn("工具处理器未在收尾预算内结束，相关运行需核对外部结果", { pending });
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.#disposePromise;
  }

  /** 保持 Agent 开始、输出检查点和完成事件的原有写入顺序 */
  async executeAgent(input: {
    readonly request: AgentRequest;
    readonly event: SynapseChannelEvent;
    readonly scope: RuntimeEventScope;
    readonly controller: AbortController;
    readonly processStateId: string | undefined;
    readonly replayToolCall: (request: ToolCallReplayRequest) => Promise<ToolCallReplayResolution>;
  }) {
    const { request, event, scope, controller, processStateId } = input;
    const sessionId = scope.accepted.session.id;
    const lineId = scope.accepted.lineEvent.lineId;
    const branchId = lineId === scope.accepted.mainline.id ? undefined : lineId;
    const sourceEventId = buildSourceEventId(event, scope.provider);
    const recorder = scope.runId === undefined ? undefined : this.recorders.get(scope.runId);
    const attemptId = recorder?.attemptId ?? `agent-attempt-${randomUUID()}`;
    const context: AgentRuntimeContext = {
      maxInputChars: this.options.maxContextChars ?? 24_000,
      ...(this.options.execution ? this.executionContext(scope.runId!) : {}),
      signal: controller.signal,
      ...(scope.runId === undefined ? {} : { runId: scope.runId }),
      ...(recorder === undefined
        ? {}
        : {
            observeModel: (modelEvent: import("@synapse/runtime-agent-core").AgentModelEvent) => {
              const intent = scope.runId ? this.options.execution?.forRun(scope.runId) : undefined;
              if (intent && modelEvent.type === "model_call_started") {
                this.options.execution!.validateIntent(intent);
                this.options.execution!.consume(intent.runId, "model");
              }
              recorder!.emit(
                modelEvent.type,
                {
                  modelCallId: modelEvent.modelCallId,
                  providerId: modelEvent.providerId,
                  model: modelEvent.model ?? null,
                  ...(modelEvent.data as Record<string, unknown>)
                },
                modelEvent.durationMs
              );
            }
          }),
      tools: this.options.tools.withContext({
        signal: controller.signal,
        timeoutMs: this.#toolTimeoutMs,
        ...(scope.runId === undefined ? {} : { runId: scope.runId }),
        ...(recorder === undefined
          ? {}
          : {
              observePermission: (decision, call) =>
                recorder!.emit(decision.decision === "allow" ? "permission_allowed" : "permission_blocked", {
                  ...decision,
                  callId: call.callId
                })
            }),
        sessionId,
        source: request.source,
        userId: request.userId,
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        attemptId,
        lineId,
        ...(branchId === undefined ? {} : { branchId }),
        causationEventId: scope.accepted.lineEvent.id,
        durableCallIdPrefix: scope.accepted.event.id,
        replayCall: async (toolCall) => {
          const intent = scope.runId ? this.options.execution?.forRun(scope.runId) : undefined;
          if (intent) this.options.execution!.validateIntent(intent);
          const replay = intent ? await this.replayOperation(toolCall) : await input.replayToolCall(toolCall);
          if (replay.status !== "missing")
            recorder?.emit("tool_call_replayed", {
              callId: toolCall.context.callId,
              name: toolCall.name,
              status: replay.status
            });
          if (replay.status === "started")
            recorder?.fail("uncertain", "tool_outcome_uncertain", "工具已有未决动作，未重新执行", "tool");
          return replay;
        }
      }),
      conversation: {
        createBranch: async (branchInput) => {
          controller.signal.throwIfAborted();
          if (branchId !== undefined) {
            throw new Error("Nested conversation branches are not supported.");
          }
          const branch = await this.options.conversationStore.createBranch({
            sessionId,
            parentMainlineId: scope.accepted.mainline.id,
            sourceEventId: scope.accepted.lineEvent.id,
            title: branchInput.title,
            goal: branchInput.goal,
            reason: branchInput.reason,
            createdBy: this.options.agent.id,
            idempotencyKey: `agent:${this.options.agent.id}:${scope.accepted.event.id}:${branchInput.idempotencyKey}`,
            contextSnapshot: branchInput.contextSnapshot ?? {
              sourceEventId: scope.accepted.lineEvent.id,
              sourceText: scope.accepted.event.text
            }
          });
          return {
            id: branch.id,
            sessionId: branch.sessionId,
            parentMainlineId: branch.parentMainlineId,
            sourceEventId: branch.sourceEventId,
            status: branch.status
          };
        }
      }
    };
    await this.options.conversationStore.appendEvent(lineId, {
      type: "agent_run_started",
      idempotencyKey: `agent-run:${sourceEventId}:${attemptId}:started`,
      sourceEventId: scope.accepted.lineEvent.id,
      causationEventId: scope.accepted.lineEvent.id,
      correlationId: attemptId,
      actorId: this.options.agent.id,
      payload: {
        attemptId,
        agentId: this.options.agent.id,
        input: request.input,
        ...(request.invocation === undefined ? {} : { invocation: summarizeInvocation(request.invocation) })
      }
    });
    this.options.logger?.info("Runtime agent run started.", {
      eventId: event.id,
      agentId: this.options.agent.id,
      sessionId: request.sessionId,
      userId: request.userId,
      input: summarizeMessage(request.input),
      ...(request.invocation === undefined ? {} : { invocation: summarizeInvocation(request.invocation) })
    });
    let run: Awaited<ReturnType<Agent["run"]>>;
    try {
      controller.signal.throwIfAborted();
      run = await withAbort(this.options.agent.run(request, context), controller.signal);
      if (scope.runId !== undefined) run = { ...run, id: scope.runId };
      if (run.status === "failed") {
        const deferred = this.deferModelFailure(scope.runId, recorder, run.failure, controller.signal);
        if (deferred && processStateId)
          await this.options.eventProcessStore.update(processStateId, { status: "received" });
        if (!deferred) recorder?.fail("failed", "agent_failed", run.error ?? "智能体未完成请求", "model");
      }
    } catch (error) {
      const serializedError = serializeError(error);
      await this.options.conversationStore.appendEvent(lineId, {
        type: "agent_run_failed",
        idempotencyKey: `agent-run:${sourceEventId}:${attemptId}:finished`,
        sourceEventId: scope.accepted.lineEvent.id,
        causationEventId: scope.accepted.lineEvent.id,
        correlationId: attemptId,
        actorId: this.options.agent.id,
        payload: {
          attemptId,
          agentId: this.options.agent.id,
          status: "failed",
          error: serializedError
        }
      });
      if (processStateId !== undefined) {
        const recoveryBlocked = error instanceof ToolCallRecoveryError;
        await this.options.eventProcessStore.update(processStateId, {
          status: recoveryBlocked ? "completed" : "received",
          errorJson: JSON.stringify({ error: serializedError })
        });
      }
      if (
        error instanceof ModelProviderError &&
        this.deferModelFailure(scope.runId, recorder, error.failure, controller.signal)
      )
        return {
          id: scope.runId!,
          agentId: this.options.agent.id,
          sessionId,
          status: "failed" as const,
          input: request.input,
          steps: [],
          error: error.message,
          failure: error.failure
        };
      throw error;
    }
    if (run.status === "succeeded" && run.output !== undefined && processStateId !== undefined) {
      try {
        await this.options.eventProcessStore.update(processStateId, {
          status: "processing",
          agentOutputText: getText(run.output),
          agentOutputJson: stringifyAgentOutput(run.output)
        });
      } catch (error) {
        this.options.logger?.warn("Runtime agent output checkpoint failed; completion event will retain the output.", {
          eventId: event.id,
          runId: run.id,
          error: error instanceof Error ? error.message : "Unknown checkpoint error."
        });
      }
    }
    await this.options.conversationStore.appendEvent(lineId, {
      type: run.status === "succeeded" ? "agent_run_completed" : "agent_run_failed",
      idempotencyKey: `agent-run:${sourceEventId}:${attemptId}:finished`,
      sourceEventId: scope.accepted.lineEvent.id,
      causationEventId: scope.accepted.lineEvent.id,
      correlationId: attemptId,
      actorId: run.agentId,
      payload: {
        attemptId,
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
        steps: run.steps,
        ...(run.output === undefined ? {} : { output: run.output }),
        ...(run.error === undefined ? {} : { error: run.error })
      }
    });
    this.options.logger?.info("Runtime agent run finished.", {
      eventId: event.id,
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      output: run.output === undefined ? undefined : summarizeMessage(run.output),
      error: run.error,
      steps: run.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        detail: step.detail,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt
      }))
    });

    return run;
  }

  private executionContext(
    runId: string
  ): Pick<AgentRuntimeContext, "checkpoint" | "acknowledgeInputs" | "getOutcome"> {
    const store = this.options.execution!;
    let first = true;
    return {
      checkpoint: async () => {
        const intent = store.forRun(runId);
        if (!intent) throw new Error("Execution intent missing");
        store.validateIntent(intent);
        const inputs = store.inputs(runId, first);
        first = false;
        return inputs;
      },
      acknowledgeInputs: (through) => store.acknowledgeInputs(runId, through),
      getOutcome: () => store.result(runId)
    };
  }

  private deferModelFailure(
    runId: string | undefined,
    recorder: RunRecorder | undefined,
    failure: ModelFailure | undefined,
    signal: AbortSignal
  ): boolean {
    if (
      !runId ||
      !recorder ||
      !failure ||
      signal.aborted ||
      !this.options.execution?.retryModel(runId, recorder.attemptId, failure)
    )
      return false;
    recorder.retryScheduled();
    return true;
  }

  private async replayOperation(call: ToolCallReplayRequest): Promise<ToolCallReplayResolution> {
    const operation = this.options.execution!.operation(call.context.callId);
    if (!operation) return { status: "missing" };
    if (
      operation.runId !== call.context.runId ||
      operation.name !== call.name ||
      !isDeepStrictEqual(operation.input, call.input)
    )
      return { status: "conflict", reason: "Operation identity conflict" };
    if (operation.state === "succeeded") return { status: "succeeded", output: operation.result };
    if (operation.state === "blocked") return { status: "blocked", reason: String(operation.result) };
    if (operation.state === "failed") return { status: "failed", error: operation.result };
    if (operation.state === "started" && operation.effect !== "external") return { status: "missing" };
    return { status: "started" };
  }

  /** 非交互执行使用同一 Agent 和工具循环，结果与交付仍独立持久化 */
  async executeBackground(
    intent: ExecutionIntent,
    compile: RuntimeCoreOptions["compileInvocation"],
    delivery: RuntimeDelivery,
    getWorkspace: RuntimeCoreOptions["getWorkspace"]
  ): Promise<void> {
    const store = this.options.execution!;
    const execution = this.beginRun(intent.runId);
    if (!execution) return;
    const recorder = this.beginRecording(intent.runId);
    const { controller, timer } = execution;
    try {
      store.validateIntent(intent);
      let outcome =
        store.result(intent.runId) ??
        (intent.payload.deliveryOfRunId ? store.result(intent.payload.deliveryOfRunId) : undefined);
      if (!outcome) {
        if (intent.payload.reminder !== undefined)
          outcome = {
            kind: "notify",
            message: { type: "text", segments: [{ type: "text", text: intent.payload.reminder }] }
          };
        else {
          let request: AgentRequest = { ...intent.payload.request, runId: intent.runId };
          const grant = store.authorize(intent.grantId);
          const task = intent.taskId ? store.getTask(intent.taskId, grant) : undefined;
          const promptContext = {
            messages: [],
            metadata: { workspaceId: intent.workspaceId },
            sections: [
              {
                id: "execution",
                blocks: [
                  {
                    id: "trusted-scope",
                    source: "runtime",
                    stability: "turn" as const,
                    required: true,
                    priority: 100,
                    content: JSON.stringify({
                      workspace: getWorkspace?.(intent.workspaceId),
                      task,
                      policy: "后台执行默认静默；需要通知或等待时调用 runtime.finish；通知仅发送到已授权来源"
                    })
                  }
                ]
              }
            ]
          };
          request = {
            ...request,
            promptContext
          };
          const invocation = await compile?.(request);
          if (invocation) request = { ...request, invocation };
          const budget = allocateContext(
            promptContext,
            this.options.maxContextChars ?? 24_000,
            trustedContextCost(
              request,
              this.options.tools.listForContext({
                runId: intent.runId,
                sessionId: request.sessionId,
                workspaceId: intent.workspaceId,
                userId: grant.principalId
              })
            )
          );
          request = {
            ...request,
            promptContext: {
              ...budget.context,
              metadata: { ...budget.context.metadata, contextManifest: JSON.stringify(budget.manifest) }
            }
          };
          const context: AgentRuntimeContext = {
            maxInputChars: this.options.maxContextChars ?? 24_000,
            ...this.executionContext(intent.runId),
            signal: controller.signal,
            runId: intent.runId,
            observeModel: (event) => {
              if (event.type === "model_call_started") {
                store.validateIntent(intent);
                store.consume(intent.runId, "model");
              }
              recorder?.emit(
                event.type,
                {
                  modelCallId: event.modelCallId,
                  providerId: event.providerId,
                  ...(event.data as Record<string, unknown>)
                },
                event.durationMs
              );
            },
            tools: this.options.tools.withContext({
              runId: intent.runId,
              sessionId: request.sessionId,
              workspaceId: intent.workspaceId,
              userId: grant.principalId,
              source: grant.source,
              signal: controller.signal,
              timeoutMs: this.#toolTimeoutMs,
              durableCallIdPrefix: intent.id,
              ...(intent.taskId ? { taskId: intent.taskId } : {}),
              replayCall: async (call) => {
                store.validateIntent(intent);
                const operation = store.operation(call.context.callId);
                if (!operation) return { status: "missing" };
                if (
                  operation.runId !== intent.runId ||
                  operation.name !== call.name ||
                  !isDeepStrictEqual(operation.input, call.input)
                )
                  return { status: "conflict", reason: "Operation identity conflict" };
                if (operation.state === "succeeded") return { status: "succeeded", output: operation.result };
                if (operation.state === "blocked") return { status: "blocked", reason: String(operation.result) };
                if (operation.state === "failed") return { status: "failed", error: operation.result };
                if (operation.state === "started" && operation.effect !== "external") return { status: "missing" };
                return { status: "started" };
              }
            }),
            conversation: {
              createBranch: async () => {
                throw new Error("Background work requires an explicit context ref");
              }
            }
          };
          const run = await withAbort(this.options.agent.run(request, context), controller.signal);
          if (run.status !== "succeeded") {
            if (this.deferModelFailure(intent.runId, recorder, run.failure, controller.signal)) return;
            throw new Error(run.error ?? "Agent failed");
          }
          outcome = run.outcome ?? store.result(intent.runId) ?? { kind: "silent" };
        }
        if (!outcome) throw new Error("Execution outcome missing");
      }
      if (!outcome) throw new Error("Execution outcome missing");
      store.saveResult(intent.runId, outcome);
      store.validateIntent(intent);
      if (outcome.kind === "silent" || outcome.kind === "waiting")
        recorder?.emit("execution_completed", { kind: outcome.kind });
      else await delivery.sendIntent(intent, outcome.message, store, controller.signal);
    } catch (error) {
      if (
        error instanceof ModelProviderError &&
        this.deferModelFailure(intent.runId, recorder, error.failure, controller.signal)
      )
        return;
      recorder?.fail(
        error instanceof ToolCallRecoveryError ? "uncertain" : "failed",
        "execution_failed",
        String(error)
      );
      this.options.logger?.warn("Background execution stopped", { runId: intent.runId, error: String(error) });
    } finally {
      this.finishRun(intent.runId, timer, recorder);
    }
  }
}

function summarizeInvocation(invocation: ModelInvocationEnvelope): Readonly<Record<string, unknown>> {
  return {
    recipeId: invocation.prompt.recipeId,
    recipeVersion: invocation.prompt.recipeVersion,
    purpose: invocation.prompt.scene.purpose,
    dimensions: invocation.prompt.scene.dimensions,
    promptIds: invocation.prompt.blocks.map((block) => `${block.promptId}@${block.version}`),
    promptDigest: invocation.prompt.digest,
    toolIds: invocation.capabilities.toolIds,
    toolSetDigest: invocation.capabilities.toolSetDigest,
    skills: invocation.capabilities.activeSkills.map((skill) => `${skill.id}@${skill.version}`),
    skillSetDigest: invocation.capabilities.skillSetDigest
  };
}
