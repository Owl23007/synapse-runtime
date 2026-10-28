import { type ChannelAdapter, type ChannelRegistry } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import { type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { ToolCallRecoveryError, type ToolRuntime, type ToolRuntimeEvent } from "@synapse/runtime-tool-runtime";
import {
  anonymousActor,
  buildSessionId,
  buildSourceEventId,
  commandResponse,
  ContextAttributorLite,
  ContextComposer,
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
  type AcceptedNormalizedEvent,
  type ContextAttributionDecision,
  type ContextAttributor,
  type ConversationBranch,
  type ConversationStore,
  type CreateBranchInput,
  type EventProcessStore,
  type IdentityResolver,
  type IdentityStore,
  type OutputPolicy,
  type TranscriptStore,
  type WorkspaceRef,
  type WorkspaceResolver,
  type WorkspaceStore
} from "../context.js";
import { InMemoryWorkspaceStore } from "../context/workspace.js";
import type { MemoryStore } from "../memory/index.js";
import { promoteExplicitMemory } from "../memory/promotion.js";
import type { RunRecorder } from "../trace/recorder.js";
import type { RunTraceStore } from "../trace/types.js";
import { RuntimeDelivery } from "./delivery.js";
import { compactGraphToolResult, serializeError, stringifyAgentOutput } from "./event-records.js";
import { getText, summarizeEvent, textMessage } from "./message-utils.js";
import { isFreshProcessState, recoveryStatusFromProcess, RuntimeRecovery } from "./recovery.js";
import { RunContextGraph } from "./run-context-graph.js";
import { RunCoordinator } from "./run-coordinator.js";
import {
  conversationStoreFromUnknown,
  identityStoreFromUnknown,
  memoryStoreFromUnknown,
  transcriptStoreFromUnknown,
  workspaceStoreFromUnknown
} from "./store-resolution.js";
import type { RuntimeCoreLogger, RuntimeCoreOptions, RuntimeEventScope, RuntimeTrace } from "./types.js";

/**
 * 对外运行门面，协调频道接收、上下文用例及独立的执行、交付和恢复流程
 */
export class RuntimeCore {
  readonly #coordinator: RunCoordinator;
  readonly #delivery: RuntimeDelivery;
  readonly #recovery: RuntimeRecovery;
  readonly #runs: RunTraceStore | undefined;
  readonly #channels: ChannelRegistry;
  readonly #conversation: ConversationRouter;
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
  readonly #removeToolObserver: () => void;
  #toolObserverRemoved = false;
  #disposePromise: Promise<void> | undefined;

  /**
   * 注入领域能力并组合内部业务用例，具体依赖由 App 装配
   */
  constructor(options: RuntimeCoreOptions) {
    this.#runs = options.runs;
    this.#channels = options.channels;
    this.#conversation = options.conversation;
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
    this.#coordinator = new RunCoordinator({
      agent: options.agent,
      tools: this.#tools,
      conversationStore: this.#conversationStore,
      eventProcessStore: this.#eventProcessStore,
      runs: this.#runs,
      logger: this.#logger,
      limits: options.limits
    });
    this.#delivery = new RuntimeDelivery({
      agentId: options.agent.id,
      channels: this.#channels,
      tools: this.#tools,
      conversationStore: this.#conversationStore,
      eventProcessStore: this.#eventProcessStore,
      transcriptStore: this.#transcriptStore,
      contextEnabled: this.#contextEnabled,
      responsePolicy: this.#responsePolicy,
      runGraph: this.#runGraph,
      logger: this.#logger,
      recorders: this.#coordinator.recorders,
      controllers: this.#coordinator.controllers,
      traces: this.#traces,
      materializeMessage: options.materializeMessage,
      selectMessage: options.selectMessage,
      prepareDelivery: options.prepareDelivery
    });
    this.#recovery = new RuntimeRecovery({
      agentId: options.agent.id,
      conversationStore: this.#conversationStore,
      eventProcessStore: this.#eventProcessStore,
      recorders: this.#coordinator.recorders,
      traces: this.#traces,
      delivery: this.#delivery
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
    return this.#coordinator.executionStatus;
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
    if (this.#coordinator.disposed) {
      return Promise.reject(new Error("Runtime is shutting down and cannot create a new conversation branch."));
    }
    return this.#coordinator.track(this.#conversationStore.createBranch(input));
  }

  /** 接收第一方输入并复用执行、恢复和工具链路，身份与来源由宿主确定 */
  submitNative(input: {
    readonly sessionId: string;
    readonly lineId?: string;
    readonly text: string;
    readonly idempotencyKey: string;
  }) {
    // 接收写入也纳入关闭等待，避免确认运行前宿主已经释放会话存储
    return this.#coordinator.track(this.#acceptNative(input));
  }

  async #acceptNative(input: Parameters<RuntimeCore["submitNative"]>[0]) {
    if (this.#coordinator.disposed || !this.#runs) throw new Error("Runtime unavailable");
    const session = await this.#conversationStore.getSession(input.sessionId);
    if (!session || session.locator?.platform !== "native") throw new Error("Native session required");
    const lineId = input.lineId ?? session.mainlineId;
    const line = await this.#conversationStore.getLine(lineId);
    if (!line || line.sessionId !== session.id) throw new Error("Invalid session line");
    const eventId = `native:${session.id}:${input.idempotencyKey}`;
    const previous = await this.#conversationStore.getNormalizedEvent(eventId);
    const event: SynapseChannelEvent = {
      id: eventId,
      platform: "native",
      channelId: "native",
      eventType: "message.created",
      origin: "incoming",
      conversation: { id: session.locator.conversationId, kind: "private" },
      sender: { id: "runtime-admin" },
      message: textMessage(input.text),
      receivedAt: previous?.receivedAt ?? new Date().toISOString()
    };
    // 原生请求绕过频道触发策略，仍使用同一份归一化事实和运行幂等键
    const accepted = await this.#conversationStore.acceptNormalizedEvent({
      id: event.id,
      sessionId: session.id,
      targetLineId: lineId,
      platform: "native",
      provider: "native",
      channelId: "native",
      conversationType: "private",
      conversationId: event.conversation.id,
      sourceEventId: event.id,
      sourceEventType: event.eventType,
      senderId: event.sender.id,
      text: input.text,
      message: event.message!,
      receivedAt: event.receivedAt,
      idempotencyKey: event.id,
      lineEventType: "user_message"
    });
    if (accepted.lineEvent.lineId !== lineId || accepted.event.text !== input.text)
      throw new Error("Idempotency key conflicts with an existing request");
    const run = this.#runs.accept({
      sourceEventId: accepted.event.id,
      sessionId: session.id,
      channelId: "native",
      lineId,
      ...(lineId === session.mainlineId ? {} : { branchId: lineId }),
      summary: input.text
    });
    const request: AgentRequest = {
      sessionId: session.id,
      userId: "runtime-admin",
      input: event.message!,
      source: {
        platform: "native",
        channelId: "native",
        conversationId: event.conversation.id,
        conversationKind: "private",
        provider: "native"
      },
      contextPolicy: { includeHistory: true, maxMessages: 20 },
      event
    };
    void this.#coordinator
      .dispatch(() => this.#runAgent(request, event, { provider: "native", accepted, runId: run.id }))
      .catch((error: unknown) => {
        if (this.#runs?.get(run.id)?.status === "accepted")
          this.#runs.append(run.id, {
            key: "dispatch-failed",
            type: "run_failed",
            status: "failed",
            error: {
              code: "dispatch_failed",
              message: error instanceof Error ? error.message : "运行无法开始",
              phase: "queue"
            }
          });
      });
    return run;
  }

  /**
   * 等待进行中的操作结束并释放工具观察器
   */
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#coordinator.dispose().finally(() => this.#removeToolObserverOnce());
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
    if (this.#coordinator.disposed) {
      return Promise.resolve();
    }

    return this.#coordinator.dispatch(() => this.#processChannelEvent(event, providerOverride, targetLineId));
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

    const controlId = scope.runId ?? `event:${scope.accepted.event.id}`;
    const execution = this.#coordinator.beginRun(controlId);
    if (execution === undefined) {
      this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
      return;
    }
    const { controller, timer } = execution;
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
        recorder = this.#coordinator.beginRecording(scope.runId);
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
          enrichedRequest.userId,
          scope.runId
        );
      }
      if (
        await this.#recovery.resume({
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
        await this.#delivery.sendOutput({
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

      const run = await this.#coordinator.executeAgent({
        request: enrichedRequest,
        event,
        scope,
        controller,
        processStateId,
        replayToolCall: (toolCall) => this.#recovery.replayToolCall(toolCall)
      });

      if (run.status === "succeeded" && run.output !== undefined) {
        if (processStateId !== undefined) {
          await this.#eventProcessStore.update(processStateId, {
            status: "agent_completed",
            agentOutputText: getText(run.output),
            agentOutputJson: stringifyAgentOutput(run.output)
          });
        }
        await this.#delivery.sendOutput({
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
        await this.#delivery.sendOutput({
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
      this.#coordinator.finishRun(controlId, timer, recorder);
      if (locallyClaimedProcessId !== undefined) {
        this.#locallyClaimedProcesses.delete(locallyClaimedProcessId);
      }
    }
  }

  /** 将已接收事件纳入会话历史，避免平台原始载荷进入上下文 */
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
    const recorder = this.#coordinator.recorders.get(event.context.runId);
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
      const raw = event.output as Record<string, unknown>;
      const output =
        raw.schemaVersion === "runtime-tool-output/v1" &&
        raw.modelOutput !== null &&
        typeof raw.modelOutput === "object"
          ? (raw.modelOutput as Record<string, unknown>)
          : raw;
      if ((event.name === "container.run" || event.name === "docker.run") && Array.isArray(output.artifacts)) {
        for (const artifact of output.artifacts)
          recorder?.emit("artifact_created", { callId: event.context.callId, artifact });
      }
      if (output.selection !== null && typeof output.selection === "object")
        recorder?.emit("artifact_selection_changed", { callId: event.context.callId, ...output.selection });
      if (event.name === "artifact.upload" && output.status !== "selected" && output.status !== "discarded")
        recorder?.emit(
          output.status === "succeeded"
            ? "artifact_upload_succeeded"
            : output.status === "uncertain"
              ? "artifact_upload_uncertain"
              : "artifact_upload_failed",
          { callId: event.context.callId, ...output }
        );
    }
    if (
      event.name === "artifact.upload" &&
      event.type === "tool_call_started" &&
      !["select", "discard"].includes(String((event.input as { operation?: unknown } | null)?.operation))
    )
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
