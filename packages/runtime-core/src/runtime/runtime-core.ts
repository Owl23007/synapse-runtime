import { randomUUID } from "node:crypto";
import { RunContextGraph } from "./run-context-graph.js";
import { RunRecorder } from "../trace/recorder.js";
import { ExecutionGate, withAbort } from "./execution-budget.js";
import type { RunTraceStore } from "../trace/types.js";
import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentRuntimeContext } from "@synapse/runtime-agent-core";
import { executeChannelAction, type ChannelAdapter, type ChannelRegistry } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import {
  messageSendAction,
  type ChannelActionResult,
  type SynapseChannelEvent,
  type SynapseMessage
} from "@synapse/runtime-protocol";
import {
  ToolCallRecoveryError,
  type ToolCallReplayRequest,
  type ToolCallReplayResolution,
  type ToolRuntime,
  type ToolRuntimeEvent
} from "@synapse/runtime-tool-runtime";
import {
  anonymousActor,
  buildSessionId,
  buildSourceEventId,
  commandResponse,
  ContextComposer,
  ContextAttributorLite,
  conversationTypeFromEvent,
  defaultWorkspace,
  IdentityResolverLite,
  InMemoryConversationStore,
  InMemoryEventProcessStore,
  InMemoryTranscriptStore,
  normalizeMessageId,
  OutputPolicyResolver,
  ResponsePolicy,
  WorkspaceResolverLite,
  type IdentityStore,
  type AcceptedNormalizedEvent,
  type ConversationBranch,
  type ConversationStore,
  type ContextAttributionDecision,
  type ContextAttributor,
  type CreateBranchInput,
  type EventProcessState,
  type LineEvent,
  type IdentityResolver,
  type EventProcessStore,
  type OutputPolicy,
  type TranscriptStore,
  type WorkspaceRef,
  type WorkspaceResolver,
  type WorkspaceStore
} from "../context.js";
import { InMemoryWorkspaceStore } from "../context/workspace.js";
import { promoteExplicitMemory } from "../memory/promotion.js";
import type { MemoryStore } from "../memory/index.js";
import type { RuntimeCoreLogger, RuntimeCoreOptions, RuntimeTrace } from "./types.js";
import {
  conversationStoreFromUnknown,
  transcriptStoreFromUnknown,
  workspaceStoreFromUnknown,
  memoryStoreFromUnknown,
  identityStoreFromUnknown
} from "./store-resolution.js";
import {
  channelSendAction,
  conservativeResponse,
  getText,
  summarizeEvent,
  summarizeMessage,
  targetFromEvent,
  textMessage,
  withReplyContext
} from "./message-utils.js";

type RuntimeEventScope = {
  readonly provider: string;
  readonly accepted: AcceptedNormalizedEvent;
  readonly runId?: string;
};

type RecoveryStatus = Exclude<EventProcessState["status"], "processing"> | "send_uncertain";

/**
 * 编排频道事件持久化、上下文构建、智能体执行与消息投递
 */
export class RuntimeCore {
  readonly #materializeMessage: RuntimeCoreOptions["materializeMessage"];
  readonly #gate: ExecutionGate;
  readonly #runTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #runControllers = new Map<string, AbortController>();
  readonly #runs: RunTraceStore | undefined;
  readonly #recorders = new Map<string, RunRecorder>();
  readonly #channels: ChannelRegistry;
  readonly #conversation: ConversationRouter;
  readonly #agent: Agent;
  readonly #runGraph: RunContextGraph | undefined;
  readonly #tools: ToolRuntime;
  readonly #logger: RuntimeCoreLogger | undefined;
  readonly #localize: (key: string, params?: Readonly<Record<string, string>>) => string;
  readonly #compileInvocation:
    | ((request: AgentRequest) => ModelInvocationEnvelope | Promise<ModelInvocationEnvelope>)
    | undefined;
  readonly #contextEnabled: boolean;
  readonly #providerByChannelId: Readonly<Record<string, string>>;
  readonly #conversationStore: ConversationStore;
  readonly #transcriptStore: TranscriptStore;
  readonly #identityResolver: IdentityResolver;
  readonly #workspaceResolver: WorkspaceResolver;
  readonly #workspaceStore: WorkspaceStore;
  readonly #contextComposer: ContextComposer;
  readonly #contextAttributor: ContextAttributor;
  readonly #outputPolicyResolver = new OutputPolicyResolver();
  readonly #responsePolicy: ResponsePolicy;
  readonly #eventProcessStore: EventProcessStore;
  readonly #enableDurableMemory: boolean;
  readonly #memoryStore: MemoryStore | undefined;
  readonly #contextHistory: {
    readonly privateHistoryTtlMinutes: number;
    readonly groupHistoryTtlMinutes: number;
    readonly channelHistoryTtlMinutes: number;
    readonly privateMaxMessages: number;
    readonly groupMaxMessages: number;
    readonly channelMaxMessages: number;
  };
  readonly #traces: RuntimeTrace[] = [];
  readonly #locallyClaimedProcesses = new Set<string>();
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #removeToolObserver: () => void;
  #disposed = false;
  #toolObserverRemoved = false;
  #disposePromise: Promise<void> | undefined;

  /**
   * 创建 RuntimeCore 并装配所需运行组件
   */
  constructor(options: RuntimeCoreOptions) {
    this.#materializeMessage = options.materializeMessage;
    this.#gate = new ExecutionGate(options.limits?.maxConcurrent ?? 4, options.limits?.maxQueued ?? 64);
    this.#runTimeoutMs = options.limits?.runTimeoutMs ?? 300_000;
    this.#toolTimeoutMs = options.limits?.toolTimeoutMs ?? 130_000;
    this.#shutdownGraceMs = options.limits?.shutdownGraceMs ?? 30_000;
    for (const value of [this.#runTimeoutMs, this.#toolTimeoutMs, this.#shutdownGraceMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("运行时间预算无效");
    this.#runs = options.runs;
    this.#channels = options.channels;
    this.#conversation = options.conversation;
    this.#agent = options.agent;
    this.#runGraph =
      options.context?.graph === undefined
        ? undefined
        : new RunContextGraph(options.context.graph, options.context.maxHistoryChars ?? 6000);
    this.#tools = options.tools;
    this.#logger = options.logger;
    this.#localize = options.localize ?? ((key) => key);
    this.#compileInvocation = options.compileInvocation;
    this.#responsePolicy = new ResponsePolicy(options.presentation?.profile);
    this.#contextEnabled = options.context?.enabled ?? true;
    this.#enableDurableMemory = options.memory?.enableDurableMemory ?? false;
    this.#contextHistory = {
      privateHistoryTtlMinutes: options.context?.privateHistoryTtlMinutes ?? 720,
      groupHistoryTtlMinutes: options.context?.groupHistoryTtlMinutes ?? 30,
      channelHistoryTtlMinutes: options.context?.channelHistoryTtlMinutes ?? 30,
      privateMaxMessages: options.context?.privateMaxMessages ?? 20,
      groupMaxMessages: options.context?.groupMaxMessages ?? 6,
      channelMaxMessages: options.context?.channelMaxMessages ?? 8
    };
    this.#providerByChannelId = options.context?.providerByChannelId ?? {};
    /**
     * 保留未显式注入持久化实现时的内存运行兼容行为
     */
    const defaultConversationStore = new InMemoryConversationStore();
    this.#conversationStore =
      options.context?.conversationStore ??
      conversationStoreFromUnknown(options.context?.transcriptStore) ??
      defaultConversationStore;
    this.#transcriptStore =
      options.context?.transcriptStore ??
      transcriptStoreFromUnknown(this.#conversationStore) ??
      new InMemoryTranscriptStore();
    const memoryStore =
      options.memory?.store ??
      options.context?.memoryStore ??
      memoryStoreFromUnknown(options.context?.conversationStore ?? options.context?.transcriptStore);
    this.#memoryStore = this.#enableDurableMemory ? memoryStore : undefined;
    this.#contextAttributor =
      options.context?.attributor ??
      new ContextAttributorLite({
        conversationStore: this.#conversationStore,
        transcriptStore: this.#transcriptStore
      });
    this.#eventProcessStore = options.context?.eventProcessStore ?? new InMemoryEventProcessStore();
    const identityStore: IdentityStore | undefined =
      options.context?.identityStore ??
      identityStoreFromUnknown(options.context?.conversationStore ?? options.context?.transcriptStore);
    this.#identityResolver =
      options.context?.identityResolver ??
      new IdentityResolverLite(identityStore === undefined ? {} : { identityStore });
    const workspaceStore =
      options.context?.workspaceStore ??
      workspaceStoreFromUnknown(options.context?.transcriptStore) ??
      new InMemoryWorkspaceStore();
    this.#workspaceStore = workspaceStore;
    this.#workspaceResolver =
      options.context?.workspaceResolver ??
      new WorkspaceResolverLite({
        ...(workspaceStore === undefined ? {} : { workspaceStore })
      });
    this.#contextComposer = new ContextComposer({
      transcriptStore: this.#transcriptStore,
      conversationStore: this.#conversationStore,
      ...(this.#memoryStore === undefined ? {} : { memoryStore: this.#memoryStore }),
      ...(options.context?.maxHistoryChars === undefined ? {} : { maxHistoryChars: options.context.maxHistoryChars }),
      ...(options.context?.timezone === undefined ? {} : { timezone: options.context.timezone }),
      ...(options.context?.strategy === undefined ? {} : { strategy: options.context.strategy }),
      ...(options.context?.cacheEnabled === undefined ? {} : { cacheEnabled: options.context.cacheEnabled })
    });
    this.#removeToolObserver = this.#tools.addObserver((event) => this.#recordToolRuntimeEvent(event));
  }

  /**
   * 返回当前进程内记录的事件运行摘要
   */
  get traces(): readonly RuntimeTrace[] {
    return this.#traces;
  }

  /** 当前实例容量与拒绝数量，不将等待请求伪装为执行中 */
  get executionStatus() {
    return this.#gate.status;
  }

  /**
   * 返回当前装配的会话存储
   */
  get conversationStore(): ConversationStore {
    return this.#conversationStore;
  }

  /**
   * 创建与主线隔离的会话分支
   */
  createBranch(input: CreateBranchInput): Promise<ConversationBranch> {
    if (this.#disposed) {
      return Promise.reject(new Error("Runtime is shutting down and cannot create a new conversation branch."));
    }
    return this.#trackOperation(this.#conversationStore.createBranch(input));
  }

  /**
   * 等待进行中的操作结束并释放工具观察器
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }

    this.#disposed = true;
    this.#gate.close();
    const inFlight = [...this.#inFlightOperations];
    this.#disposePromise = (async () => {
      const timer = setTimeout(() => {
        for (const controller of this.#runControllers.values()) controller.abort(new Error("Runtime 退出收尾超时"));
      }, this.#shutdownGraceMs);
      try {
        await Promise.allSettled(inFlight);
        const pending = await this.#tools.drain();
        if (pending > 0) this.#logger?.warn("工具处理器未在收尾预算内结束，相关运行需核对外部结果", { pending });
      } finally {
        clearTimeout(timer);
        this.#removeToolObserverOnce();
      }
    })();
    return this.#disposePromise;
  }

  /**
   * 注册频道适配器并接收其事件
   */
  attachChannel(adapter: ChannelAdapter): void {
    this.#channels.register(adapter);
    this.#logger?.info("Runtime channel attached.", {
      channelId: adapter.id,
      channelType: adapter.type,
      provider: adapter.provider
    });
    adapter.onEvent((event) => this.handleChannelEvent(event, adapter.provider));
  }

  /**
   * 接收频道事件并纳入运行时操作生命周期
   */
  handleChannelEvent(event: SynapseChannelEvent, providerOverride?: string, targetLineId?: string): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }

    return this.#trackOperation(this.#gate.run(() => this.#processChannelEvent(event, providerOverride, targetLineId)));
  }

  async #processChannelEvent(
    event: SynapseChannelEvent,
    providerOverride?: string,
    targetLineId?: string
  ): Promise<void> {
    const provider = providerOverride ?? this.#providerByChannelId[event.channelId] ?? "unknown";
    let enrichedEvent = event;
    try {
      enrichedEvent = await this.#enrichTriggerHints(event, provider);
    } catch (error) {
      this.#logger?.warn("Runtime reply trigger enrichment failed; continuing with the original channel event.", {
        eventId: event.id,
        error: error instanceof Error ? error.message : "Unknown trigger enrichment error."
      });
    }
    this.#logger?.info("Runtime received channel event.", summarizeEvent(enrichedEvent));
    const decision = this.#conversation.route(enrichedEvent);

    if (!decision.shouldRespond || decision.request === undefined) {
      this.#traces.push({ eventId: enrichedEvent.id, status: "ignored", reason: decision.reason });
      this.#logger?.info("Runtime ignored channel event.", {
        ...summarizeEvent(enrichedEvent),
        reason: decision.reason,
        trigger: decision.trigger
      });
      return;
    }

    let attribution: ContextAttributionDecision | undefined;
    if (this.#contextEnabled) {
      try {
        attribution = await this.#contextAttributor.attribute({
          event: enrichedEvent,
          provider,
          sessionId: buildSessionId(enrichedEvent, provider),
          ...(targetLineId === undefined ? {} : { explicitTargetLineId: targetLineId })
        });
      } catch (error) {
        this.#logger?.warn("Runtime context attribution failed; falling back to the requested or main line.", {
          eventId: enrichedEvent.id,
          error: error instanceof Error ? error.message : "Unknown context attribution error."
        });
      }
    }

    let accepted: AcceptedNormalizedEvent;
    let runId: string | undefined;
    try {
      accepted = await this.#acceptChannelEvent(enrichedEvent, provider, attribution?.targetLineId ?? targetLineId);
      runId = this.#runs?.accept({
        sourceEventId: accepted.event.id,
        sessionId: accepted.session.id,
        channelId: enrichedEvent.channelId,
        lineId: accepted.lineEvent.lineId,
        ...(accepted.lineEvent.lineId === accepted.mainline.id ? {} : { branchId: accepted.lineEvent.lineId }),
        summary: getText(decision.request.input)
      }).id;
      if (attribution !== undefined && accepted.created) {
        await this.#recordContextAttribution(accepted, attribution);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown conversation persistence error.";
      this.#traces.push({ eventId: enrichedEvent.id, status: "failed", reason: `persistence_failed: ${reason}` });
      this.#logger?.error("Runtime rejected channel event because durable acceptance failed.", {
        ...summarizeEvent(enrichedEvent),
        provider,
        error: reason
      });
      return;
    }

    if (attribution !== undefined) {
      this.#logger?.info("Runtime attributed channel event context.", {
        eventId: enrichedEvent.id,
        sessionId: attribution.sessionId,
        lineId: accepted.lineEvent.lineId,
        action: attribution.action,
        nature: attribution.nature,
        confidence: attribution.confidence,
        reasons: attribution.reasons
      });
    }

    if (this.#contextEnabled && accepted.lineEvent.type === "user_message" && enrichedEvent.message !== undefined) {
      try {
        await this.#appendIncomingTranscript(enrichedEvent, provider, accepted);
      } catch (error) {
        this.#logger?.warn("Runtime inbound transcript projection failed; canonical event remains available.", {
          eventId: enrichedEvent.id,
          error: error instanceof Error ? error.message : "Unknown transcript error."
        });
      }
    }

    this.#logger?.info("Runtime accepted channel event.", {
      ...summarizeEvent(enrichedEvent),
      sessionId: decision.request.sessionId,
      userId: decision.request.userId,
      reason: decision.reason,
      trigger: decision.trigger
    });
    await this.#runAgent(decision.request, enrichedEvent, {
      provider,
      accepted,
      ...(runId === undefined ? {} : { runId })
    });
  }

  async #runAgent(request: AgentRequest, event: SynapseChannelEvent, scope: RuntimeEventScope): Promise<void> {
    const provider = scope.provider;
    const sessionId = scope.accepted.session.id;
    const lineId = scope.accepted.lineEvent.lineId;
    const branchId = lineId === scope.accepted.mainline.id ? undefined : lineId;
    const conversationType = conversationTypeFromEvent(event);
    let enrichedRequest: AgentRequest = {
      ...request,
      sessionId,
      lineId,
      ...(branchId === undefined ? {} : { branchId })
    };
    let workspace: WorkspaceRef | undefined;
    let outputPolicy: OutputPolicy | undefined;
    let processStateId: string | undefined;
    let locallyClaimedProcessId: string | undefined;
    let recorder: RunRecorder | undefined;
    const trace = scope.runId === undefined ? undefined : this.#runs?.get(scope.runId);
    if (trace !== undefined && !["accepted", "running", "interrupted"].includes(trace.status)) {
      this.#traces.push({ eventId: event.id, status: "ignored", reason: `run_${trace.status}`, runId: trace.id });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("运行已超过截止时间")), this.#runTimeoutMs);
    const controlId = scope.runId ?? `event:${scope.accepted.event.id}`;
    if (this.#runControllers.has(controlId)) {
      clearTimeout(timer);
      this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
      return;
    }
    this.#runControllers.set(controlId, controller);
    try {
      let actor = anonymousActor(event, provider);
      try {
        actor = await this.#identityResolver.resolve(event, provider);
      } catch (error) {
        this.#logger?.warn("Runtime identity resolve failed; falling back to guest actor.", {
          eventId: event.id,
          error: error instanceof Error ? error.message : "Unknown identity error."
        });
      }

      try {
        workspace = await this.#workspaceResolver.resolve(event, actor);
      } catch (error) {
        workspace = defaultWorkspace(event, actor);
        this.#logger?.warn("Runtime workspace resolve failed; falling back to default workspace.", {
          eventId: event.id,
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : "Unknown workspace error."
        });
      }

      outputPolicy = this.#outputPolicyResolver.resolve(workspace);
      enrichedRequest = {
        ...enrichedRequest,
        userId: actor.identity.id,
        source: { ...enrichedRequest.source, provider }
      };
      const sourceEventId = buildSourceEventId(event, provider);
      let processState;

      try {
        processState = await this.#eventProcessStore.begin({
          platform: event.platform,
          provider,
          channelId: event.channelId,
          conversationType,
          conversationId: event.conversation.id,
          sourceEventId,
          sourceEventType: event.eventType
        });
        processStateId = processState.id;
      } catch (error) {
        this.#logger?.error("Runtime recovery state persistence failed; agent execution was not started.", {
          eventId: event.id,
          sourceEventId,
          error: error instanceof Error ? error.message : "Unknown idempotency error."
        });
        throw error;
      }

      if (processState?.status === "completed") {
        if (trace?.status === "accepted")
          this.#runs?.append(trace.id, {
            key: "legacy-completed",
            type: "run_interrupted",
            status: "interrupted",
            phase: "legacy",
            data: { reason: "历史处理已完成，旧版本没有运行追踪，未重新执行" }
          });
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "duplicate_completed" });
        return;
      }

      if (
        processState?.status === "processing" &&
        trace?.status !== "interrupted" &&
        isFreshProcessState(processState.updatedAt)
      ) {
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
        return;
      }

      const recoveryStatus = recoveryStatusFromProcess(processState);
      if (this.#locallyClaimedProcesses.has(processState.id)) {
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
        return;
      }
      this.#locallyClaimedProcesses.add(processState.id);
      locallyClaimedProcessId = processState.id;
      /**
       * 持久化 claim 与进程内 claim 共同阻止并发投递重复执行智能体
       */
      const claim =
        this.#eventProcessStore.claim === undefined
          ? {
              claimed: true,
              state: await this.#eventProcessStore.update(processState.id, { status: "processing" })
            }
          : await this.#eventProcessStore.claim(processState.id, {
              expectedStatus: processState.status,
              expectedUpdatedAt: processState.updatedAt
            });
      if (!claim.claimed) {
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
        return;
      }
      processStateId = claim.state.id;
      if (scope.runId !== undefined && this.#runs !== undefined) {
        recorder = new RunRecorder(scope.runId, this.#runs);
        this.#recorders.set(scope.runId, recorder);
      }

      if (branchId !== undefined) {
        let branch = await this.#conversationStore.getBranch(branchId);
        if (branch === undefined) {
          throw new Error(`Conversation branch "${branchId}" does not exist.`);
        }
        if (
          branch.status === "completed" ||
          branch.status === "merged" ||
          branch.status === "failed" ||
          branch.status === "cancelled"
        ) {
          branch = await this.#conversationStore.transitionBranch(branch.id, {
            status: "inactive",
            idempotencyKey: `runtime:branch-reopen:${scope.accepted.event.id}`,
            createdAt: event.receivedAt
          });
        }
        if (branch.status === "created" || branch.status === "blocked" || branch.status === "inactive") {
          await this.#conversationStore.transitionBranch(branch.id, {
            status: "active",
            idempotencyKey: `runtime:branch-activate:${scope.accepted.event.id}`,
            createdAt: event.receivedAt
          });
        } else if (branch.status !== "active") {
          throw new Error(`Conversation branch "${branch.id}" cannot execute while it is "${branch.status}".`);
        }
      }

      const commandOutput = await commandResponse(event, actor, workspace, sessionId, this.#conversationStore, {
        enableDurableMemory: this.#enableDurableMemory,
        ...(this.#memoryStore === undefined ? {} : { memoryStore: this.#memoryStore }),
        workspaceStore: this.#workspaceStore,
        sourceEventId: scope.accepted.event.id
      });
      if (commandOutput === undefined) {
        this.#runGraph?.begin(
          sessionId,
          lineId,
          scope.accepted.lineEvent.id,
          getText(request.input),
          enrichedRequest.userId
        );
      }
      if (
        await this.#resumeRecoveredProcess({
          event,
          request: enrichedRequest,
          scope,
          processState,
          recoveryStatus,
          commandOutput,
          workspace,
          outputPolicy,
          processStateId
        })
      ) {
        return;
      }

      try {
        await promoteExplicitMemory(this.#memoryStore, {
          message: request.input,
          actor,
          workspace,
          sourceEventId
        });
      } catch (error) {
        this.#logger?.warn("Runtime explicit memory promotion failed; continuing without durable promotion.", {
          eventId: event.id,
          error: error instanceof Error ? error.message : "Unknown memory promotion error."
        });
      }

      if (this.#contextEnabled) {
        try {
          const incoming = await this.#appendIncomingTranscript(event, provider, scope.accepted);
          if (processStateId !== undefined) {
            await this.#eventProcessStore.update(processStateId, {
              incomingMessageId: incoming.id
            });
          }
          const historyTtlMinutes = historyTtlForConversation(conversationType, this.#contextHistory);
          const promptContext =
            request.contextPolicy.includeHistory || branchId !== undefined
              ? await this.#contextComposer.compose({
                  event,
                  actor,
                  workspace,
                  outputPolicy,
                  sessionId,
                  lineId,
                  ...(branchId === undefined ? {} : { branchId }),
                  currentInput: request.input,
                  currentSourceEventId: sourceEventId,
                  includeHistory: request.contextPolicy.includeHistory,
                  maxMessages: maxMessagesForConversation(
                    conversationType,
                    request.contextPolicy.maxMessages,
                    this.#contextHistory
                  ),
                  ...(historyTtlMinutes === undefined ? {} : { historyTtlMinutes }),
                  ...(request.trigger === undefined ? {} : { trigger: request.trigger })
                })
              : undefined;
          enrichedRequest = {
            ...enrichedRequest,
            ...(promptContext === undefined ? {} : { promptContext })
          };
        } catch (error) {
          this.#logger?.warn("Runtime context compose failed; falling back to single-turn request.", {
            eventId: event.id,
            error: error instanceof Error ? error.message : "Unknown context error."
          });
        }
      }

      if (commandOutput !== undefined) {
        await this.#sendOutput({
          event,
          request: enrichedRequest,
          runId: scope.runId ?? `command-${event.id}`,
          output: commandOutput,
          workspace,
          outputPolicy,
          processStateId,
          conversation: scope.accepted
        });
        return;
      }

      if (this.#compileInvocation !== undefined) {
        enrichedRequest = {
          ...enrichedRequest,
          invocation: await this.#compileInvocation(enrichedRequest)
        };
      }

      const graphContext = this.#contextEnabled
        ? this.#runGraph?.compose(sessionId, lineId, enrichedRequest.promptContext)
        : undefined;
      if (graphContext !== undefined) enrichedRequest = { ...enrichedRequest, promptContext: graphContext };
      recorder?.emit("context_resolved", {
        sessionId,
        lineId,
        promptContext: enrichedRequest.promptContext ?? null,
        invocation: enrichedRequest.invocation ?? null
      });

      const attemptId = recorder?.attemptId ?? `agent-attempt-${randomUUID()}`;
      const context: AgentRuntimeContext = {
        signal: controller.signal,
        ...(scope.runId === undefined ? {} : { runId: scope.runId }),
        ...(recorder === undefined
          ? {}
          : {
              observeModel: (event: import("@synapse/runtime-agent-core").AgentModelEvent) =>
                recorder!.emit(
                  event.type,
                  {
                    modelCallId: event.modelCallId,
                    providerId: event.providerId,
                    model: event.model ?? null,
                    ...(event.data as Record<string, unknown>)
                  },
                  event.durationMs
                )
            }),
        tools: this.#tools.withContext({
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
          source: enrichedRequest.source,
          userId: enrichedRequest.userId,
          attemptId,
          lineId,
          ...(branchId === undefined ? {} : { branchId }),
          causationEventId: scope.accepted.lineEvent.id,
          durableCallIdPrefix: scope.accepted.event.id,
          replayCall: async (toolCall) => {
            const replay = await this.#resolveToolCallReplay(toolCall);
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
          createBranch: async (input) => {
            controller.signal.throwIfAborted();
            if (branchId !== undefined) {
              throw new Error("Nested conversation branches are not supported.");
            }
            const branch = await this.#conversationStore.createBranch({
              sessionId,
              parentMainlineId: scope.accepted.mainline.id,
              sourceEventId: scope.accepted.lineEvent.id,
              title: input.title,
              goal: input.goal,
              reason: input.reason,
              createdBy: this.#agent.id,
              idempotencyKey: `agent:${this.#agent.id}:${scope.accepted.event.id}:${input.idempotencyKey}`,
              contextSnapshot: input.contextSnapshot ?? {
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
      await this.#conversationStore.appendEvent(lineId, {
        type: "agent_run_started",
        idempotencyKey: `agent-run:${sourceEventId}:${attemptId}:started`,
        sourceEventId: scope.accepted.lineEvent.id,
        causationEventId: scope.accepted.lineEvent.id,
        correlationId: attemptId,
        actorId: this.#agent.id,
        payload: {
          attemptId,
          agentId: this.#agent.id,
          input: enrichedRequest.input,
          ...(enrichedRequest.invocation === undefined
            ? {}
            : { invocation: summarizeInvocation(enrichedRequest.invocation) })
        }
      });
      this.#logger?.info("Runtime agent run started.", {
        eventId: event.id,
        agentId: this.#agent.id,
        sessionId: enrichedRequest.sessionId,
        userId: enrichedRequest.userId,
        input: summarizeMessage(enrichedRequest.input),
        ...(enrichedRequest.invocation === undefined
          ? {}
          : { invocation: summarizeInvocation(enrichedRequest.invocation) })
      });
      let run: Awaited<ReturnType<Agent["run"]>>;
      try {
        controller.signal.throwIfAborted();
        run = await withAbort(this.#agent.run(enrichedRequest, context), controller.signal);
        if (scope.runId !== undefined) run = { ...run, id: scope.runId };
        if (run.status === "failed") recorder?.fail("failed", "agent_failed", run.error ?? "智能体未完成请求", "model");
      } catch (error) {
        const serializedError = serializeError(error);
        await this.#conversationStore.appendEvent(lineId, {
          type: "agent_run_failed",
          idempotencyKey: `agent-run:${sourceEventId}:${attemptId}:finished`,
          sourceEventId: scope.accepted.lineEvent.id,
          causationEventId: scope.accepted.lineEvent.id,
          correlationId: attemptId,
          actorId: this.#agent.id,
          payload: {
            attemptId,
            agentId: this.#agent.id,
            status: "failed",
            error: serializedError
          }
        });
        if (processStateId !== undefined) {
          const recoveryBlocked = error instanceof ToolCallRecoveryError;
          await this.#eventProcessStore.update(processStateId, {
            status: recoveryBlocked ? "completed" : "received",
            errorJson: JSON.stringify({ error: serializedError })
          });
        }
        throw error;
      }
      if (run.status === "succeeded" && run.output !== undefined && processStateId !== undefined) {
        try {
          await this.#eventProcessStore.update(processStateId, {
            status: "processing",
            agentOutputText: getText(run.output),
            agentOutputJson: stringifyAgentOutput(run.output)
          });
        } catch (error) {
          this.#logger?.warn("Runtime agent output checkpoint failed; completion event will retain the output.", {
            eventId: event.id,
            runId: run.id,
            error: error instanceof Error ? error.message : "Unknown checkpoint error."
          });
        }
      }
      await this.#conversationStore.appendEvent(lineId, {
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
      this.#logger?.info("Runtime agent run finished.", {
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

      if (run.status === "succeeded" && run.output !== undefined) {
        if (processStateId !== undefined) {
          await this.#eventProcessStore.update(processStateId, {
            status: "agent_completed",
            agentOutputText: getText(run.output),
            agentOutputJson: stringifyAgentOutput(run.output)
          });
        }
        await this.#sendOutput({
          event,
          request: enrichedRequest,
          runId: run.id,
          output: run.output,
          workspace,
          outputPolicy,
          processStateId,
          conversation: scope.accepted
        });
        return;
      }

      if (run.status === "failed") {
        await this.#sendOutput({
          event,
          request: enrichedRequest,
          runId: run.id,
          output: textMessage(this.#localize("agent.request_failed")),
          workspace,
          outputPolicy,
          processStateId,
          conversation: scope.accepted
        });
        return;
      }

      if (processStateId !== undefined) {
        await this.#eventProcessStore.update(processStateId, {
          status: "completed",
          ...(run.error === undefined ? {} : { errorJson: JSON.stringify({ error: run.error }) })
        });
      }
      this.#traces.push({
        eventId: event.id,
        status: run.status === "succeeded" ? "succeeded" : "failed",
        runId: run.id
      });
      this.#logger?.info("Runtime event completed.", {
        eventId: event.id,
        runId: run.id,
        status: run.status === "succeeded" ? "succeeded" : "failed",
        error: run.error
      });
    } catch (error) {
      recorder?.fail(
        error instanceof ToolCallRecoveryError ? "uncertain" : "failed",
        "runtime_error",
        error instanceof Error ? error.message : "运行失败"
      );
      if (recorder === undefined && trace?.status === "accepted") {
        try {
          this.#runs?.append(trace.id, {
            key: "acceptance-failed",
            type: "run_failed",
            status: "failed",
            error: {
              code: "runtime_error",
              message: error instanceof Error ? error.message : "运行失败",
              phase: "context"
            }
          });
        } catch {
          this.#logger?.error("Run acceptance failure could not be persisted.", { runId: trace.id });
        }
      }
      this.#traces.push({
        eventId: event.id,
        status: "failed",
        reason: error instanceof Error ? error.message : "Unknown runtime error."
      });
      this.#logger?.error("Runtime event failed with unhandled error.", {
        eventId: event.id,
        error: error instanceof Error ? error.message : "Unknown runtime error."
      });
    } finally {
      clearTimeout(timer);
      this.#runControllers.delete(controlId);
      if (recorder !== undefined) {
        try {
          recorder.finish();
        } catch {
          this.#logger?.error("Run terminal state could not be persisted; recovery is required.", {
            runId: recorder.runId
          });
        }
        this.#recorders.delete(recorder.runId);
      }
      if (locallyClaimedProcessId !== undefined) {
        this.#locallyClaimedProcesses.delete(locallyClaimedProcessId);
      }
    }
  }

  /**
   * 恢复崩溃前已持久化的智能体输出或投递结果
   *
   * 返回 true 表示该事件已被恢复路径完全处理，调用方不应重新执行智能体
   */
  async #resumeRecoveredProcess(input: {
    readonly event: SynapseChannelEvent;
    readonly request: AgentRequest;
    readonly scope: RuntimeEventScope;
    readonly processState: EventProcessState;
    readonly recoveryStatus: RecoveryStatus;
    readonly commandOutput: SynapseMessage | undefined;
    readonly workspace: WorkspaceRef;
    readonly outputPolicy: OutputPolicy;
    readonly processStateId: string | undefined;
  }): Promise<boolean> {
    const { event, request, scope, processState, commandOutput, workspace, outputPolicy, processStateId } = input;
    let recoveryStatus = input.recoveryStatus;
    let recoveredOutput =
      parseAgentOutput(processState.agentOutputJson) ??
      (processState.agentOutputText === undefined ? undefined : textMessage(processState.agentOutputText));
    if (recoveredOutput === undefined) {
      const completedAgentEvent = await this.#findCompletedAgentEvent(scope.accepted);
      const persistedOutput = completedAgentEvent === undefined ? undefined : agentOutputFromEvent(completedAgentEvent);
      if (persistedOutput !== undefined) {
        recoveredOutput = persistedOutput;
        if (recoveryStatus === "received") {
          recoveryStatus = "agent_completed";
        }
        await this.#eventProcessStore.update(processState.id, {
          status: "processing",
          agentOutputText: getText(persistedOutput),
          agentOutputJson: stringifyAgentOutput(persistedOutput)
        });
      }
    }
    if (recoveredOutput !== undefined && commandOutput === undefined) {
      await this.#ensureCompletedAgentEvent(scope.accepted, recoveredOutput, event.id);
    }

    if (recoveryStatus === "send_uncertain") {
      const assistantEvent = await this.#findAssistantEvent(scope.accepted);
      if (assistantEvent === undefined || recoveredOutput === undefined) {
        throw new Error(`Uncertain delivery for "${scope.accepted.event.id}" is missing its persisted output.`);
      }
      const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
      await this.#appendDeliveryEvent(
        { event, runId: recoveredRunId, conversation: scope.accepted },
        assistantEvent,
        "delivery_uncertain",
        {
          recovered: true,
          reason: "The previous process stopped after delivery started; output was not sent again."
        }
      );
      const output = this.#applyResponsePolicy(recoveredOutput, outputPolicy, event.id, recoveredRunId);
      const assistant = await this.#appendAssistantTranscript(
        event,
        output,
        scope.accepted,
        undefined,
        assistantEvent.id
      );
      await this.#eventProcessStore.update(processState.id, {
        status: "completed",
        ...(assistant === undefined ? {} : { assistantMessageId: assistant.id }),
        errorJson: JSON.stringify({ phase: "send_uncertain" })
      });
      this.#traces.push({
        eventId: event.id,
        status: "failed",
        reason: "delivery_outcome_uncertain",
        runId: recoveredRunId
      });
      return true;
    }

    if ((recoveryStatus === "agent_completed" || recoveryStatus === "send_failed") && recoveredOutput !== undefined) {
      const assistantEvent = await this.#findAssistantEvent(scope.accepted);
      if (assistantEvent !== undefined) {
        const delivered = await this.#findSuccessfulDelivery(scope.accepted, assistantEvent);
        if (delivered !== undefined) {
          const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
          this.#recorders
            .get(recoveredRunId)
            ?.emit("response_sent", { recovered: true, externalMessageId: externalMessageIdFromDelivery(delivered) });
          const output = this.#applyResponsePolicy(recoveredOutput, outputPolicy, event.id, recoveredRunId);
          const assistant = await this.#appendAssistantTranscript(
            event,
            output,
            scope.accepted,
            externalMessageIdFromDelivery(delivered),
            assistantEvent.id
          );
          await this.#eventProcessStore.update(processState.id, {
            status: "completed",
            ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
          });
          this.#traces.push({ eventId: event.id, status: "succeeded", runId: recoveredRunId });
          return true;
        }
      }
      await this.#sendOutput({
        event,
        request,
        runId: scope.runId ?? `recovered-${event.id}`,
        output: recoveredOutput,
        workspace,
        outputPolicy,
        processStateId,
        conversation: scope.accepted
      });
      return true;
    }

    if (recoveryStatus !== "send_succeeded") {
      return false;
    }

    if (recoveredOutput === undefined) {
      await this.#eventProcessStore.update(processState.id, {
        status: "completed",
        errorJson: JSON.stringify({ error: "send_succeeded_without_output" })
      });
      this.#traces.push({ eventId: event.id, status: "ignored", reason: "send_succeeded_without_output" });
      return true;
    }

    const recoveredRunId = scope.runId ?? `recovered-${event.id}`;
    const assistantEvent = await this.#findAssistantEvent(scope.accepted);
    if (assistantEvent === undefined) {
      throw new Error(`Persisted assistant event for "${scope.accepted.event.id}" does not exist.`);
    }
    const sendResult = parseSendResult(processState.sendResultJson);
    const delivered = await this.#findSuccessfulDelivery(scope.accepted, assistantEvent);
    if (delivered === undefined) {
      await this.#appendDeliveryEvent(
        { event, runId: recoveredRunId, conversation: scope.accepted },
        assistantEvent,
        "delivery_succeeded",
        {
          ...(sendResult?.messageId === undefined ? {} : { externalMessageId: sendResult.messageId }),
          recovered: true
        }
      );
    }
    const output = this.#applyResponsePolicy(recoveredOutput, outputPolicy, event.id, recoveredRunId);
    const assistant = await this.#appendAssistantTranscript(
      event,
      output,
      scope.accepted,
      sendResult?.messageId,
      assistantEvent.id
    );
    await this.#eventProcessStore.update(processState.id, {
      status: "completed",
      ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
    });
    this.#traces.push({ eventId: event.id, status: "succeeded", runId: recoveredRunId });
    this.#recorders
      .get(recoveredRunId)
      ?.emit("response_sent", { recovered: true, externalMessageId: sendResult?.messageId });
    return true;
  }

  async #findSuccessfulDelivery(
    conversation: AcceptedNormalizedEvent,
    assistantEvent: LineEvent
  ): Promise<LineEvent | undefined> {
    const deliveryEvents = await this.#conversationStore.listEvents(conversation.mainline.id, {
      types: ["delivery_succeeded"]
    });
    return deliveryEvents.find((delivery) => delivery.sourceEventId === assistantEvent.id);
  }

  async #sendOutput(input: {
    readonly event: SynapseChannelEvent;
    readonly request: AgentRequest;
    readonly runId: string;
    readonly output: SynapseMessage;
    readonly workspace: WorkspaceRef | undefined;
    readonly outputPolicy: OutputPolicy | undefined;
    readonly processStateId: string | undefined;
    readonly conversation: AcceptedNormalizedEvent;
  }): Promise<void> {
    // 恢复路径同样经过这里，图提交可按原事件补齐且不会触发第二次群文件上传
    const signal = (
      this.#runControllers.get(input.runId) ?? this.#runControllers.get(`event:${input.conversation.event.id}`)
    )?.signal;
    signal?.throwIfAborted();
    if (this.#runGraph !== undefined) {
      const results = await this.#conversationStore.listEvents(input.conversation.lineEvent.lineId, {
        types: ["tool_result"]
      });
      for (const result of results) {
        if (result.sourceEventId !== input.conversation.lineEvent.id) continue;
        const payload = recordPayload(result);
        if (typeof payload?.callId !== "string") continue;
        this.#runGraph.record(
          input.conversation.session.id,
          input.conversation.lineEvent.id,
          `graph-tool:${payload.callId}`,
          "tool_result",
          {
            name: payload.name,
            callId: payload.callId,
            ...compactGraphToolResult(payload)
          }
        );
      }
    }
    const publishedCommit = this.#runGraph?.finish(
      input.conversation.session.id,
      input.conversation.lineEvent.lineId,
      input.conversation.lineEvent.id,
      getText(input.output)
    );
    this.#recorders.get(input.runId)?.emit("context_committed", {
      sessionId: input.conversation.session.id,
      ...(publishedCommit === undefined ? {} : { commitId: publishedCommit.id, parents: publishedCommit.parents }),
      refName: `run:${input.conversation.lineEvent.id}`,
      lineRef: `line:${input.conversation.lineEvent.lineId}`
    });
    const channel = this.#channels.get(input.event.channelId);
    const presented = this.#applyResponsePolicy(input.output, input.outputPolicy, input.event.id, input.runId);
    // 仅支持文本的既有频道保留文本回退，媒体频道不能静默丢弃已确认附件
    const output: SynapseMessage =
      channel?.getCapabilities().sendMedia === false
        ? { ...presented, type: "text", segments: [{ type: "text", text: getText(presented) }] }
        : presented;
    if (
      output !== presented &&
      presented.segments.some((segment) => ["image", "file", "audio", "video", "sticker"].includes(segment.type))
    ) {
      this.#logger?.warn("Runtime channel does not support media; delivering text fallback.", {
        eventId: input.event.id,
        channelId: input.event.channelId
      });
    }
    const assistantEvent = await this.#conversationStore.appendEvent(input.conversation.lineEvent.lineId, {
      type: "assistant_message",
      idempotencyKey: `assistant:${input.conversation.event.id}`,
      sourceEventId: input.conversation.lineEvent.id,
      causationEventId: input.conversation.lineEvent.id,
      correlationId: input.conversation.event.id,
      actorId: this.#agent.id,
      payload: {
        role: "assistant",
        message: output,
        text: getText(output)
      }
    });

    if (input.conversation.lineEvent.lineId !== input.conversation.mainline.id) {
      await this.#publishBranchOutput(input.conversation, assistantEvent, output);
    }

    const target = targetFromEvent(input.event);

    if (channel === undefined) {
      await this.#appendDeliveryEvent(input, assistantEvent, "delivery_failed", {
        error: `Channel "${input.event.channelId}" is not registered.`
      });
      if (input.processStateId !== undefined) {
        await this.#eventProcessStore.update(input.processStateId, {
          status: "completed",
          errorJson: JSON.stringify({ error: `Channel "${input.event.channelId}" is not registered.` })
        });
      }
      this.#traces.push({
        eventId: input.event.id,
        status: "failed",
        reason: `Channel "${input.event.channelId}" is not registered.`
      });
      this.#logger?.error("Runtime send failed because channel is not registered.", {
        eventId: input.event.id,
        runId: input.runId,
        channelId: input.event.channelId
      });
      return;
    }

    if (input.processStateId !== undefined) {
      /**
       * 在频道发送前保存完整输出以便崩溃恢复时跳过重复智能体执行
       */
      await this.#eventProcessStore.update(input.processStateId, {
        agentOutputText: getText(input.output),
        agentOutputJson: stringifyAgentOutput(input.output)
      });
    }

    let permission = await this.#tools.decidePermission({
      action: channelSendAction(target),
      resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
      subject: input.request.userId,
      metadata: {
        eventId: input.event.id,
        runId: input.runId,
        conversationKind: input.event.conversation.kind
      }
    });

    if (
      permission.decision === "allow" &&
      output.segments.some((segment) => ["image", "file", "audio", "video", "sticker"].includes(segment.type))
    ) {
      permission = await this.#tools.decidePermission({
        action: `channel.${input.event.platform}.send_media`,
        resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
        subject: input.request.userId
      });
    }

    if (
      permission.decision === "allow" &&
      target.type === "group" &&
      output.segments.some((segment) => segment.type === "file")
    ) {
      permission = await this.#tools.decidePermission({
        action: "channel.qq.upload_group_file",
        resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
        subject: input.request.userId
      });
    }

    this.#recorders
      .get(input.runId)
      ?.emit(permission.decision === "allow" ? "permission_allowed" : "permission_blocked", {
        ...permission,
        purpose: "response"
      });
    if (permission.decision !== "allow") {
      const reason = permission.reason ?? `Permission decision was "${permission.decision}".`;
      await this.#appendDeliveryEvent(input, assistantEvent, "delivery_blocked", {
        decision: permission.decision,
        reason
      });
      if (input.processStateId !== undefined) {
        await this.#eventProcessStore.update(input.processStateId, {
          status: "completed",
          errorJson: JSON.stringify({ error: reason })
        });
      }
      this.#traces.push({
        eventId: input.event.id,
        status: "blocked",
        reason,
        runId: input.runId
      });
      return;
    }

    let result: ChannelActionResult;
    if (input.processStateId === undefined) {
      throw new Error("Event process state is required before channel delivery.");
    }
    signal?.throwIfAborted();
    await this.#eventProcessStore.update(input.processStateId, {
      status: "processing",
      errorJson: JSON.stringify({ phase: "send_started", runId: input.runId })
    });
    this.#recorders.get(input.runId)?.emit("response_sending", { target, output });
    /**
     * send_started 之后的异常按投递结果不确定处理以避免自动重复发送
     */
    try {
      signal?.throwIfAborted();
      const delivery = executeChannelAction(
        channel,
        messageSendAction({
          actionId: `message.send:${input.event.id}`,
          channelId: input.event.channelId,
          target,
          message: withReplyContext(
            this.#materializeMessage?.(input.conversation.session.id, output) ?? output,
            input.event
          ),
          conversation: input.event.conversation,
          idempotencyKey: `send:${input.event.id}`
        })
      );
      result = await (signal ? withAbort(delivery, signal) : delivery);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Channel send threw an unknown error.";
      await this.#appendDeliveryEvent(input, assistantEvent, "delivery_failed", {
        error: reason,
        thrown: true
      });
      await this.#eventProcessStore.update(input.processStateId, {
        status: "completed",
        errorJson: JSON.stringify({ phase: "send_uncertain", error: reason })
      });
      this.#traces.push({
        eventId: input.event.id,
        status: "failed",
        reason,
        runId: input.runId
      });
      return;
    }

    if (result.status !== "succeeded") {
      const reason = result.errorMessage ?? `Channel action ${result.status}.`;
      await this.#appendDeliveryEvent(input, assistantEvent, "delivery_failed", {
        error: reason,
        errorCode: result.errorCode,
        retryable: result.retryable
      });
      if (input.processStateId !== undefined) {
        await this.#eventProcessStore.update(input.processStateId, {
          status: "send_failed",
          errorJson: JSON.stringify({ error: reason, errorCode: result.errorCode })
        });
      }
      this.#traces.push({
        eventId: input.event.id,
        status: "failed",
        reason,
        runId: input.runId
      });
      return;
    }

    if (input.processStateId !== undefined) {
      await this.#eventProcessStore.update(input.processStateId, {
        status: "send_succeeded",
        sendResultJson: JSON.stringify(result)
      });
    }
    await this.#appendDeliveryEvent(input, assistantEvent, "delivery_succeeded", {
      ...(result.externalMessageId === undefined ? {} : { externalMessageId: result.externalMessageId })
    });

    try {
      const assistant = await this.#appendAssistantTranscript(
        input.event,
        output,
        input.conversation,
        result.externalMessageId,
        assistantEvent.id
      );

      if (input.processStateId !== undefined) {
        await this.#eventProcessStore.update(input.processStateId, {
          status: "completed",
          ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
        });
      }
    } catch (error) {
      this.#logger?.warn("Runtime assistant transcript append failed after successful send.", {
        eventId: input.event.id,
        runId: input.runId,
        error: error instanceof Error ? error.message : "Unknown transcript error."
      });
    }

    this.#traces.push({ eventId: input.event.id, status: "succeeded", runId: input.runId });
  }

  /**
   * Branches provide isolated, durable context; they are not an alternate user-facing
   * output line. Persist the raw assistant event on the branch, then publish a
   * structured result to the parent mainline before delivery. Both operations have
   * event-scoped idempotency keys so recovery can safely repeat this projection.
   */
  async #publishBranchOutput(
    conversation: AcceptedNormalizedEvent,
    assistantEvent: LineEvent,
    output: SynapseMessage
  ): Promise<void> {
    const branchId = conversation.lineEvent.lineId;
    const result = await this.#conversationStore.createBranchResult(branchId, {
      status: "completed",
      summary: getText(output).trim() || "Assistant response.",
      artifacts: [
        {
          kind: "assistant_output",
          message: output,
          text: getText(output)
        }
      ],
      sourceEventId: assistantEvent.id,
      idempotencyKey: `runtime:branch-output:${conversation.event.id}`
    });
    await this.#conversationStore.publishBranchResult(branchId, conversation.mainline.id, {
      resultId: result.id,
      idempotencyKey: `runtime:branch-output:${conversation.event.id}:publish`
    });
  }

  async #appendDeliveryEvent(
    input: {
      readonly event: SynapseChannelEvent;
      readonly runId: string;
      readonly conversation: AcceptedNormalizedEvent;
    },
    assistantEvent: LineEvent,
    type: "delivery_succeeded" | "delivery_failed" | "delivery_blocked" | "delivery_uncertain",
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await this.#conversationStore.appendEvent(input.conversation.mainline.id, {
      type,
      idempotencyKey: `${type}:${input.conversation.event.id}:${input.runId}`,
      sourceEventId: assistantEvent.id,
      causationEventId: assistantEvent.id,
      correlationId: input.conversation.event.id,
      actorId: this.#agent.id,
      payload: {
        runId: input.runId,
        ...payload
      }
    });
    const recorder = this.#recorders.get(input.runId);
    if (type === "delivery_blocked")
      recorder?.fail("blocked", "response_blocked", String(payload.reason ?? "消息发送被权限阻止"), "response");
    else
      recorder?.emit(
        type === "delivery_succeeded"
          ? "response_sent"
          : type === "delivery_uncertain" || payload.thrown === true
            ? "response_send_uncertain"
            : "response_send_failed",
        payload
      );
  }

  #applyResponsePolicy(
    message: SynapseMessage,
    policy: OutputPolicy | undefined,
    eventId: string,
    runId: string
  ): SynapseMessage {
    if (policy === undefined) {
      return message;
    }

    try {
      return this.#responsePolicy.apply(message, policy);
    } catch (error) {
      this.#logger?.warn("Runtime response policy failed; using conservative truncation.", {
        eventId,
        runId,
        error: error instanceof Error ? error.message : "Unknown response policy error."
      });
      return conservativeResponse(message, policy);
    }
  }

  async #appendAssistantTranscript(
    event: SynapseChannelEvent,
    output: SynapseMessage,
    conversation: AcceptedNormalizedEvent,
    externalMessageId?: string,
    lineEventId?: string
  ) {
    if (!this.#contextEnabled) {
      return undefined;
    }

    const provider = conversation.event.provider;
    const normalizedExternalMessageId = normalizeMessageId(externalMessageId);
    return this.#transcriptStore.append({
      sessionId: conversation.session.id,
      lineId: conversation.lineEvent.lineId,
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      sourceEventId: `${buildSourceEventId(event, provider)}:assistant`,
      role: "assistant",
      text: getText(output),
      message: output,
      eventType: "assistant_message",
      idempotencyKey: `assistant:${conversation.event.id}`,
      ...(lineEventId === undefined ? {} : { lineEventId }),
      ...(normalizedExternalMessageId === undefined ? {} : { externalMessageId: normalizedExternalMessageId }),
      createdAt: new Date().toISOString()
    });
  }

  async #appendIncomingTranscript(event: SynapseChannelEvent, provider: string, conversation: AcceptedNormalizedEvent) {
    return this.#transcriptStore.append({
      sessionId: conversation.session.id,
      lineId: conversation.lineEvent.lineId,
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      sourceEventId: conversation.event.sourceEventId,
      role: "user",
      actorId: conversation.event.senderId,
      text: getText(event.message),
      ...(event.message === undefined ? {} : { message: event.message }),
      ...(event.raw === undefined ? {} : { rawPayload: event.raw }),
      eventType: event.eventType,
      idempotencyKey: conversation.event.idempotencyKey,
      normalizedEventId: conversation.event.id,
      lineEventId: conversation.lineEvent.id,
      createdAt: event.receivedAt
    });
  }

  async #findAssistantEvent(conversation: AcceptedNormalizedEvent): Promise<LineEvent | undefined> {
    const events = await this.#conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["assistant_message"]
    });
    return events.find((event) => event.idempotencyKey === `assistant:${conversation.event.id}`);
  }

  async #findCompletedAgentEvent(conversation: AcceptedNormalizedEvent): Promise<LineEvent | undefined> {
    const events = await this.#conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["agent_run_completed"]
    });
    return events.findLast((event) => event.sourceEventId === conversation.lineEvent.id);
  }

  async #ensureCompletedAgentEvent(
    conversation: AcceptedNormalizedEvent,
    output: SynapseMessage,
    runtimeEventId: string
  ): Promise<LineEvent | undefined> {
    const completed = await this.#findCompletedAgentEvent(conversation);
    if (completed !== undefined) {
      return completed;
    }

    const startedEvents = await this.#conversationStore.listEvents(conversation.lineEvent.lineId, {
      types: ["agent_run_started"]
    });
    const started = startedEvents.findLast((event) => event.sourceEventId === conversation.lineEvent.id);
    if (started === undefined) {
      return undefined;
    }
    const attemptId = agentAttemptIdFromEvent(started);
    if (attemptId === undefined) {
      return undefined;
    }

    return this.#conversationStore.appendEvent(conversation.lineEvent.lineId, {
      type: "agent_run_completed",
      idempotencyKey: `agent-run:${conversation.event.sourceEventId}:${attemptId}:finished`,
      sourceEventId: conversation.lineEvent.id,
      causationEventId: conversation.lineEvent.id,
      correlationId: started.correlationId ?? attemptId,
      actorId: this.#agent.id,
      payload: {
        attemptId,
        runId: `recovered-${runtimeEventId}`,
        agentId: this.#agent.id,
        status: "succeeded",
        steps: [],
        output,
        recovered: true
      }
    });
  }

  async #acceptChannelEvent(
    event: SynapseChannelEvent,
    provider: string,
    targetLineId?: string
  ): Promise<AcceptedNormalizedEvent> {
    const sessionId = buildSessionId(event, provider);
    const sourceEventId = buildSourceEventId(event, provider);
    const sourceMessageId = normalizeMessageId(event.message?.id);

    return this.#conversationStore.acceptNormalizedEvent({
      sessionId,
      ...(targetLineId === undefined ? {} : { targetLineId }),
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      sourceEventId,
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      sourceEventType: event.eventType,
      senderId: event.sender.id,
      text: getText(event.message),
      ...(event.message === undefined ? {} : { message: event.message, segments: event.message.segments }),
      ...(event.triggerHint === undefined ? {} : { triggerHint: event.triggerHint }),
      ...(event.raw === undefined ? {} : { rawPayload: event.raw }),
      receivedAt: event.receivedAt,
      idempotencyKey: runtimeEventIdempotencyKey(event, provider, sourceEventId),
      lineEventType: lineEventTypeFromChannelEvent(event),
      actorId: event.sender.id,
      sessionMetadata: {
        ...(event.conversation.title === undefined ? {} : { conversationTitle: event.conversation.title })
      }
    });
  }

  async #recordContextAttribution(
    conversation: AcceptedNormalizedEvent,
    decision: ContextAttributionDecision
  ): Promise<void> {
    await this.#conversationStore.appendEvent(conversation.lineEvent.lineId, {
      type: "context_attributed",
      idempotencyKey: `context-attribution:${conversation.event.id}`,
      sourceEventId: conversation.lineEvent.id,
      causationEventId: conversation.lineEvent.id,
      correlationId: conversation.event.id,
      actorId: "runtime",
      payload: {
        action: decision.action,
        nature: decision.nature,
        targetLineId: conversation.lineEvent.lineId,
        confidence: decision.confidence,
        reasons: decision.reasons,
        candidates: decision.candidates
      },
      createdAt: conversation.event.acceptedAt
    });
  }

  async #recordToolRuntimeEvent(event: ToolRuntimeEvent): Promise<void> {
    const session = await this.#conversationStore.ensureSession({ sessionId: event.context.sessionId });
    const lineId = event.context.lineId ?? session.mainlineId;
    const isCall = event.type === "tool_call_started";
    const toolCallEvent = isCall
      ? undefined
      : (await this.#conversationStore.listEvents(lineId, { types: ["tool_call"] })).find(
          (candidate) => candidate.idempotencyKey === `tool:${event.context.callId}:tool_call_started`
        );
    const causationEventId = toolCallEvent?.id ?? event.context.causationEventId;
    const resultPayload =
      event.type === "tool_call_succeeded"
        ? { status: "succeeded", ...(event.output === undefined ? {} : { output: event.output }) }
        : event.type === "tool_call_blocked"
          ? { status: "blocked", reason: event.reason }
          : event.type === "tool_call_failed"
            ? { status: "failed", error: serializeError(event.error) }
            : {};

    await this.#conversationStore.appendEvent(lineId, {
      sessionId: event.context.sessionId,
      type: isCall ? "tool_call" : "tool_result",
      idempotencyKey: `tool:${event.context.callId}:${event.type}`,
      ...(event.context.causationEventId === undefined ? {} : { sourceEventId: event.context.causationEventId }),
      ...(causationEventId === undefined ? {} : { causationEventId }),
      correlationId: event.context.attemptId ?? event.context.runId,
      ...(event.context.taskId === undefined ? {} : { taskId: event.context.taskId }),
      actorId: event.context.userId,
      payload: {
        callId: event.context.callId,
        name: event.name,
        ...(event.input === undefined ? {} : { input: event.input }),
        ...resultPayload,
        ...(event.context.branchId === undefined ? {} : { branchId: event.context.branchId })
      },
      createdAt: event.occurredAt
    });
    const recorder = this.#recorders.get(event.context.runId);
    if (
      event.type === "tool_call_failed" &&
      event.error instanceof ToolCallRecoveryError &&
      event.error.code === "outcome_uncertain"
    )
      recorder?.fail("uncertain", "tool_outcome_uncertain", "工具执行已中止，外部结果未确认", "tool");
    recorder?.emit(event.type, {
      name: event.name,
      callId: event.context.callId,
      input: event.input,
      ...resultPayload
    });
    if (event.type === "tool_call_succeeded" && event.output !== null && typeof event.output === "object") {
      const output = event.output as Record<string, unknown>;
      if (event.name === "container.run" && Array.isArray(output.artifacts)) {
        for (const artifact of output.artifacts)
          recorder?.emit("artifact_created", { callId: event.context.callId, artifact });
      }
      if (event.name === "artifact.upload")
        recorder?.emit(
          output.status === "succeeded"
            ? "artifact_upload_succeeded"
            : output.status === "uncertain"
              ? "artifact_upload_uncertain"
              : "artifact_upload_failed",
          { callId: event.context.callId, ...output }
        );
    }
    if (event.name === "artifact.upload" && event.type === "tool_call_started")
      recorder?.emit("artifact_upload_started", { callId: event.context.callId, input: event.input });
    if (!isCall && event.context.causationEventId !== undefined) {
      this.#runGraph?.record(
        event.context.sessionId,
        event.context.causationEventId,
        `graph-tool:${event.context.callId}`,
        "tool_result",
        {
          name: event.name,
          callId: event.context.callId,
          // 工具输出只保留有界结构化结果，输入中的脚本留在执行审计而不重复注入模型上下文
          ...compactGraphToolResult(resultPayload)
        }
      );
    }
  }

  async #resolveToolCallReplay(request: ToolCallReplayRequest): Promise<ToolCallReplayResolution> {
    const lineId = request.context.lineId;
    if (lineId === undefined) {
      return {
        status: "conflict",
        reason: `Durable tool call "${request.context.callId}" has no conversation line scope.`
      };
    }

    const events = await this.#conversationStore.listEvents(lineId, {
      types: ["tool_call", "tool_result"]
    });
    const started = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_started`);
    if (started === undefined) {
      return { status: "missing" };
    }
    const startedPayload = recordPayload(started);
    if (
      startedPayload?.callId !== request.context.callId ||
      startedPayload.name !== request.name ||
      !isDeepStrictEqual(startedPayload.input, request.input) ||
      started.taskId !== request.context.taskId
    ) {
      return {
        status: "conflict",
        reason: `Durable tool call "${request.context.callId}" conflicts with the replayed name, input, or task scope.`
      };
    }

    const succeeded = events.find(
      (event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_succeeded`
    );
    if (succeeded !== undefined) {
      return { status: "succeeded", output: recordPayload(succeeded)?.output };
    }
    const blocked = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_blocked`);
    if (blocked !== undefined) {
      const reason = recordPayload(blocked)?.reason;
      return {
        status: "blocked",
        reason: typeof reason === "string" ? reason : "The durable permission decision blocked this tool call."
      };
    }
    const failed = events.find((event) => event.idempotencyKey === `tool:${request.context.callId}:tool_call_failed`);
    if (failed !== undefined) {
      return { status: "failed", error: recordPayload(failed)?.error };
    }
    await this.#conversationStore.appendEvent(lineId, {
      type: "tool_result",
      idempotencyKey: `tool:${request.context.callId}:tool_call_uncertain`,
      ...(started.sourceEventId === undefined ? {} : { sourceEventId: started.sourceEventId }),
      causationEventId: started.id,
      correlationId: started.correlationId ?? request.context.attemptId ?? request.context.runId,
      ...(started.taskId === undefined ? {} : { taskId: started.taskId }),
      actorId: request.context.userId,
      payload: {
        callId: request.context.callId,
        name: request.name,
        ...(request.input === undefined ? {} : { input: request.input }),
        status: "uncertain",
        reason: "The tool call started previously, but no durable outcome was recorded; it was not executed again."
      }
    });
    return { status: "started" };
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    const remove = (): boolean => this.#inFlightOperations.delete(operation);
    void operation.then(remove, remove);
    return operation;
  }

  #removeToolObserverOnce(): void {
    if (this.#toolObserverRemoved) {
      return;
    }
    this.#toolObserverRemoved = true;
    this.#removeToolObserver();
  }

  async #enrichTriggerHints(event: SynapseChannelEvent, provider: string): Promise<SynapseChannelEvent> {
    const replyTargetMessageId = normalizeMessageId(
      event.message?.replyTo?.messageId ?? event.triggerHint?.replyTargetMessageId
    );
    if (replyTargetMessageId === undefined || this.#transcriptStore.findByExternalMessageId === undefined) {
      return event;
    }

    const matched = await this.#transcriptStore.findByExternalMessageId({
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      externalMessageId: replyTargetMessageId
    });

    return {
      ...event,
      triggerHint: {
        ...event.triggerHint,
        replyTargetMessageId,
        repliedToBot: matched !== undefined
      }
    };
  }
}

function compactGraphToolResult(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const raw = payload.output;
  const output =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => !["stdout", "stderr", "logs", "script"].includes(key)))
      : raw;
  const result = { status: payload.status, reason: payload.reason, output, error: payload.error };
  const json = JSON.stringify(result);
  // 不截断 JSON，也不把未验证的工具全文当成新的系统指令
  return json.length <= 4000 ? result : { status: payload.status, truncated: true };
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

function maxMessagesForConversation(
  conversationType: ReturnType<typeof conversationTypeFromEvent>,
  fallback: number,
  options: {
    readonly privateMaxMessages: number;
    readonly groupMaxMessages: number;
    readonly channelMaxMessages: number;
  }
): number {
  if (conversationType === "private") {
    return options.privateMaxMessages;
  }

  if (conversationType === "group") {
    return options.groupMaxMessages;
  }

  if (conversationType === "channel") {
    return options.channelMaxMessages;
  }

  return fallback;
}

function historyTtlForConversation(
  conversationType: ReturnType<typeof conversationTypeFromEvent>,
  options: {
    readonly privateHistoryTtlMinutes: number;
    readonly groupHistoryTtlMinutes: number;
    readonly channelHistoryTtlMinutes: number;
  }
): number | undefined {
  if (conversationType === "private") {
    return options.privateHistoryTtlMinutes;
  }

  if (conversationType === "group") {
    return options.groupHistoryTtlMinutes;
  }

  if (conversationType === "channel") {
    return options.channelHistoryTtlMinutes;
  }

  return undefined;
}

function parseSendResult(value: string | undefined): { readonly messageId?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { readonly messageId?: unknown; readonly externalMessageId?: unknown };
    const messageId = normalizeMessageId(parsed.messageId ?? parsed.externalMessageId);
    return messageId === undefined ? {} : { messageId };
  } catch {
    return undefined;
  }
}

function stringifyAgentOutput(message: SynapseMessage): string {
  return JSON.stringify(message, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

function parseAgentOutput(value: string | undefined): SynapseMessage | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SynapseMessage>;
    return typeof parsed.type === "string" && Array.isArray(parsed.segments) ? (parsed as SynapseMessage) : undefined;
  } catch {
    return undefined;
  }
}

function processPhase(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { readonly phase?: unknown };
    return typeof parsed.phase === "string" ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

function recoveryStatusFromProcess(process: EventProcessState): RecoveryStatus {
  if (process.status !== "processing") {
    return process.status;
  }

  if (processPhase(process.errorJson) === "send_started") {
    return "send_uncertain";
  }

  if (process.sendResultJson !== undefined) {
    return "send_succeeded";
  }

  return process.agentOutputJson !== undefined || process.agentOutputText !== undefined
    ? "agent_completed"
    : "received";
}

function agentOutputFromEvent(event: LineEvent): SynapseMessage | undefined {
  if (typeof event.payload !== "object" || event.payload === null || !("output" in event.payload)) {
    return undefined;
  }
  const output = (event.payload as { readonly output?: unknown }).output;
  if (
    typeof output !== "object" ||
    output === null ||
    !("type" in output) ||
    typeof output.type !== "string" ||
    !("segments" in output) ||
    !Array.isArray(output.segments)
  ) {
    return undefined;
  }
  return output as SynapseMessage;
}

function agentAttemptIdFromEvent(event: LineEvent): string | undefined {
  if (typeof event.payload === "object" && event.payload !== null && "attemptId" in event.payload) {
    const attemptId = (event.payload as { readonly attemptId?: unknown }).attemptId;
    if (typeof attemptId === "string" && attemptId.length > 0) {
      return attemptId;
    }
  }
  return event.correlationId;
}

function recordPayload(event: LineEvent): Readonly<Record<string, unknown>> | undefined {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : undefined;
}

function externalMessageIdFromDelivery(event: LineEvent): string | undefined {
  if (typeof event.payload !== "object" || event.payload === null || !("externalMessageId" in event.payload)) {
    return undefined;
  }
  return normalizeMessageId((event.payload as { readonly externalMessageId?: unknown }).externalMessageId);
}

function isFreshProcessState(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return Date.now() - updatedAtMs < 5 * 60 * 1000;
}

function runtimeEventIdempotencyKey(event: SynapseChannelEvent, provider: string, sourceEventId: string): string {
  return ["channel-event", event.platform, provider, event.channelId, sourceEventId, event.eventType].join("\u001f");
}

function lineEventTypeFromChannelEvent(event: SynapseChannelEvent): "user_message" | "system_message" | "correction" {
  if (event.eventType === "message.created") {
    return "user_message";
  }
  if (event.eventType === "message.deleted") {
    return "correction";
  }
  return "system_message";
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof ToolCallRecoveryError ? { code: error.code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
  }
  return error;
}
