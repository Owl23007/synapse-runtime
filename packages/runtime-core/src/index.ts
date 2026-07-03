import type { Agent, AgentRuntimeContext } from "@synapse/runtime-agent-core";
import type { ChannelAdapter, ChannelRegistry, ChannelTarget } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { ToolRuntime } from "@synapse/runtime-tool-runtime";
import {
  anonymousActor,
  buildSessionId,
  buildSourceEventId,
  commandResponse,
  ContextComposer,
  conversationTypeFromEvent,
  defaultWorkspace,
  IdentityResolverLite,
  InMemoryEventProcessStore,
  InMemoryTranscriptStore,
  OutputPolicyResolver,
  ResponsePolicy,
  WorkspaceResolverLite,
  type IdentityResolver,
  type EventProcessStore,
  type OutputPolicy,
  type TranscriptStore,
  type WorkspaceRef,
  type WorkspaceResolver,
  type WorkspaceStore
} from "./context.js";

export * from "./context.js";

export interface RuntimeCoreOptions {
  readonly channels: ChannelRegistry;
  readonly conversation: ConversationRouter;
  readonly agent: Agent;
  readonly tools: ToolRuntime;
  readonly logger?: RuntimeCoreLogger;
  readonly memory?: {
    readonly enableDurableMemory?: boolean;
  };
  readonly context?: {
    readonly enabled?: boolean;
    readonly providerByChannelId?: Readonly<Record<string, string>>;
    readonly transcriptStore?: TranscriptStore;
    readonly eventProcessStore?: EventProcessStore;
    readonly identityResolver?: IdentityResolver;
    readonly workspaceResolver?: WorkspaceResolver;
    readonly workspaceStore?: WorkspaceStore;
    readonly maxHistoryChars?: number;
  };
}

export interface RuntimeCoreLogger {
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface RuntimeTrace {
  readonly eventId: string;
  readonly status: "ignored" | "succeeded" | "failed" | "blocked";
  readonly reason?: string;
  readonly runId?: string;
}

export class RuntimeCore {
  readonly #channels: ChannelRegistry;
  readonly #conversation: ConversationRouter;
  readonly #agent: Agent;
  readonly #tools: ToolRuntime;
  readonly #logger: RuntimeCoreLogger | undefined;
  readonly #contextEnabled: boolean;
  readonly #providerByChannelId: Readonly<Record<string, string>>;
  readonly #transcriptStore: TranscriptStore;
  readonly #identityResolver: IdentityResolver;
  readonly #workspaceResolver: WorkspaceResolver;
  readonly #contextComposer: ContextComposer;
  readonly #outputPolicyResolver = new OutputPolicyResolver();
  readonly #responsePolicy = new ResponsePolicy();
  readonly #eventProcessStore: EventProcessStore;
  readonly #enableDurableMemory: boolean;
  readonly #traces: RuntimeTrace[] = [];

  constructor(options: RuntimeCoreOptions) {
    this.#channels = options.channels;
    this.#conversation = options.conversation;
    this.#agent = options.agent;
    this.#tools = options.tools;
    this.#logger = options.logger;
    this.#contextEnabled = options.context?.enabled ?? true;
    this.#enableDurableMemory = options.memory?.enableDurableMemory ?? false;
    this.#providerByChannelId = options.context?.providerByChannelId ?? {};
    this.#transcriptStore = options.context?.transcriptStore ?? new InMemoryTranscriptStore();
    this.#eventProcessStore = options.context?.eventProcessStore ?? new InMemoryEventProcessStore();
    this.#identityResolver = options.context?.identityResolver ?? new IdentityResolverLite();
    const workspaceStore = options.context?.workspaceStore ?? workspaceStoreFromUnknown(options.context?.transcriptStore);
    this.#workspaceResolver = options.context?.workspaceResolver ?? new WorkspaceResolverLite({
      ...(workspaceStore === undefined ? {} : { workspaceStore })
    });
    this.#contextComposer = new ContextComposer({
      transcriptStore: this.#transcriptStore,
      ...(options.context?.maxHistoryChars === undefined ? {} : { maxHistoryChars: options.context.maxHistoryChars })
    });
  }

  get traces(): readonly RuntimeTrace[] {
    return this.#traces;
  }

  attachChannel(adapter: ChannelAdapter): void {
    this.#channels.register(adapter);
    this.#logger?.info("Runtime channel attached.", {
      channelId: adapter.id,
      channelType: adapter.type,
      provider: adapter.provider
    });
    adapter.onEvent((event) => this.handleChannelEvent(event));
  }

  async handleChannelEvent(event: SynapseChannelEvent): Promise<void> {
    this.#logger?.info("Runtime received channel event.", summarizeEvent(event));
    const decision = this.#conversation.route(event);

    if (!decision.shouldRespond || decision.request === undefined) {
      this.#traces.push({ eventId: event.id, status: "ignored", reason: decision.reason });
      this.#logger?.info("Runtime ignored channel event.", {
        ...summarizeEvent(event),
        reason: decision.reason
      });
      return;
    }

    this.#logger?.info("Runtime accepted channel event.", {
      ...summarizeEvent(event),
      sessionId: decision.request.sessionId,
      userId: decision.request.userId,
      reason: decision.reason
    });
    await this.#runAgent(decision.request, event);
  }

  async #runAgent(request: AgentRequest, event: SynapseChannelEvent): Promise<void> {
    const provider = this.#providerByChannelId[event.channelId] ?? "unknown";
    const sessionId = buildSessionId(event, provider);
    const conversationType = conversationTypeFromEvent(event);
    let enrichedRequest: AgentRequest = { ...request, sessionId };
    let workspace: WorkspaceRef | undefined;
    let outputPolicy: OutputPolicy | undefined;
    let processStateId: string | undefined;

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
          sourceEventId
        });
        processStateId = processState.id;
      } catch (error) {
        this.#logger?.warn("Runtime idempotency begin failed; continuing without recovery state.", {
          eventId: event.id,
          sourceEventId,
          error: error instanceof Error ? error.message : "Unknown idempotency error."
        });
      }

      if (processState?.status === "completed") {
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "duplicate_completed" });
        return;
      }

      if (processState?.status === "processing" && isFreshProcessState(processState.updatedAt)) {
        this.#traces.push({ eventId: event.id, status: "ignored", reason: "already_processing" });
        return;
      }

      const commandOutput = commandResponse(event, actor, workspace, { enableDurableMemory: this.#enableDurableMemory });
      const recoveredOutput = processState?.agentOutputText === undefined ? undefined : textMessage(processState.agentOutputText);

      if ((processState?.status === "agent_completed" || processState?.status === "send_failed") && recoveredOutput !== undefined) {
        await this.#sendOutput({
          event,
          request: enrichedRequest,
          runId: `recovered-${event.id}`,
          output: recoveredOutput,
          workspace,
          outputPolicy,
          processStateId
        });
        return;
      }

      if (processState?.status === "send_succeeded") {
        const sendSucceededState = processState;
        if (recoveredOutput !== undefined) {
          const output = this.#applyResponsePolicy(recoveredOutput, outputPolicy, event.id, `recovered-${event.id}`);
          const assistant = await this.#appendAssistantTranscript(event, output);
          await this.#eventProcessStore.update(sendSucceededState.id, {
            status: "completed",
            ...(assistant === undefined ? {} : { assistantMessageId: assistant.id })
          });
          this.#traces.push({ eventId: event.id, status: "succeeded", runId: `recovered-${event.id}` });
        } else {
          this.#traces.push({ eventId: event.id, status: "ignored", reason: "send_succeeded_without_output" });
        }
        return;
      }

      if (this.#contextEnabled) {
        try {
          const incoming = await this.#transcriptStore.append({
            sessionId,
            platform: event.platform,
            provider,
            channelId: event.channelId,
            conversationType,
            conversationId: event.conversation.id,
            sourceEventId,
            role: "user",
            actorId: actor.identity.id,
            text: getText(event.message),
            createdAt: event.receivedAt
          });
          if (processStateId !== undefined) {
            await this.#eventProcessStore.update(processStateId, { status: "processing", incomingMessageId: incoming.id });
          }
          const promptContext = request.contextPolicy.includeHistory ? await this.#contextComposer.compose({
            event,
            actor,
            workspace,
            outputPolicy,
            sessionId,
            currentInput: request.input,
            currentSourceEventId: sourceEventId,
            maxMessages: conversationType === "group" ? 8 : request.contextPolicy.maxMessages
          }) : undefined;
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
        await this.#sendOutput({ event, request: enrichedRequest, runId: `command-${event.id}`, output: commandOutput, workspace, outputPolicy, processStateId });
        return;
      }

      const context: AgentRuntimeContext = { tools: this.#tools };
      this.#logger?.info("Runtime agent run started.", {
        eventId: event.id,
        agentId: this.#agent.id,
        sessionId: enrichedRequest.sessionId,
        userId: enrichedRequest.userId,
        input: summarizeMessage(enrichedRequest.input)
      });
      const run = await this.#agent.run(enrichedRequest, context);
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
          await this.#eventProcessStore.update(processStateId, { status: "agent_completed", agentOutputText: getText(run.output) });
        }
        await this.#sendOutput({ event, request: enrichedRequest, runId: run.id, output: run.output, workspace, outputPolicy, processStateId });
        return;
      }

      this.#traces.push({ eventId: event.id, status: run.status === "succeeded" ? "succeeded" : "failed", runId: run.id });
      this.#logger?.info("Runtime event completed.", {
        eventId: event.id,
        runId: run.id,
        status: run.status === "succeeded" ? "succeeded" : "failed",
        error: run.error
      });
    } catch (error) {
      this.#traces.push({
        eventId: event.id,
        status: "failed",
        reason: error instanceof Error ? error.message : "Unknown runtime error."
      });
      this.#logger?.error("Runtime event failed with unhandled error.", {
        eventId: event.id,
        error: error instanceof Error ? error.message : "Unknown runtime error."
      });
    }
  }

  async #sendOutput(input: {
    readonly event: SynapseChannelEvent;
    readonly request: AgentRequest;
    readonly runId: string;
    readonly output: SynapseMessage;
    readonly workspace: WorkspaceRef | undefined;
    readonly outputPolicy: OutputPolicy | undefined;
    readonly processStateId: string | undefined;
  }): Promise<void> {
    const channel = this.#channels.get(input.event.channelId);
    const target = targetFromEvent(input.event);

    if (channel === undefined) {
      this.#traces.push({ eventId: input.event.id, status: "failed", reason: `Channel "${input.event.channelId}" is not registered.` });
      this.#logger?.error("Runtime send failed because channel is not registered.", {
        eventId: input.event.id,
        runId: input.runId,
        channelId: input.event.channelId
      });
      return;
    }

    if (input.processStateId !== undefined) {
      await this.#eventProcessStore.update(input.processStateId, { agentOutputText: getText(input.output) });
    }

    const permission = await this.#tools.decidePermission({
      action: channelSendAction(target),
      resource: `${input.event.platform}:${input.event.channelId}:${input.event.conversation.id}`,
      subject: input.request.userId,
      metadata: {
        eventId: input.event.id,
        runId: input.runId,
        conversationKind: input.event.conversation.kind
      }
    });

    if (permission.decision !== "allow") {
      this.#traces.push({
        eventId: input.event.id,
        status: "blocked",
        reason: permission.reason ?? `Permission decision was "${permission.decision}".`,
        runId: input.runId
      });
      return;
    }

    const output = this.#applyResponsePolicy(input.output, input.outputPolicy, input.event.id, input.runId);
    const result = await channel.sendMessage(target, withReplyContext(output, input.event));

    if (!result.ok) {
      if (input.processStateId !== undefined) {
        await this.#eventProcessStore.update(input.processStateId, {
          status: "send_failed",
          errorJson: JSON.stringify({ error: result.error ?? "Channel send failed." })
        });
      }
      this.#traces.push({ eventId: input.event.id, status: "failed", reason: result.error ?? "Channel send failed.", runId: input.runId });
      return;
    }

    if (input.processStateId !== undefined) {
      await this.#eventProcessStore.update(input.processStateId, {
        status: "send_succeeded",
        sendResultJson: JSON.stringify(result)
      });
    }

    try {
      const assistant = await this.#appendAssistantTranscript(input.event, output);

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

  async #appendAssistantTranscript(event: SynapseChannelEvent, output: SynapseMessage) {
    if (!this.#contextEnabled) {
      return undefined;
    }

    const provider = this.#providerByChannelId[event.channelId] ?? "unknown";
    return this.#transcriptStore.append({
      sessionId: buildSessionId(event, provider),
      platform: event.platform,
      provider,
      channelId: event.channelId,
      conversationType: conversationTypeFromEvent(event),
      conversationId: event.conversation.id,
      sourceEventId: `${buildSourceEventId(event, provider)}:assistant`,
      role: "assistant",
      text: getText(output),
      createdAt: new Date().toISOString()
    });
  }
}

function targetFromEvent(event: SynapseChannelEvent): ChannelTarget {
  if (event.conversation.kind === "private") {
    return { type: "private", userId: event.conversation.id };
  }

  if (event.conversation.kind === "group") {
    return { type: "group", groupId: event.conversation.id };
  }

  return { type: "channel", channelId: event.conversation.id };
}

function channelSendAction(target: ChannelTarget): string {
  if (target.type === "private") {
    return "channel.qq.send_private_message";
  }

  if (target.type === "group") {
    return "channel.qq.send_group_message";
  }

  return "channel.qq.send_channel_message";
}

function withReplyContext(message: SynapseMessage, event: SynapseChannelEvent): SynapseMessage {
  return {
    ...message,
    replyTo: {
      ...(event.message?.id === undefined ? {} : { messageId: event.message.id }),
      eventId: event.id
    }
  };
}

function summarizeEvent(event: SynapseChannelEvent): Readonly<Record<string, unknown>> {
  return {
    eventId: event.id,
    platform: event.platform,
    channelId: event.channelId,
    eventType: event.eventType,
    conversation: event.conversation,
    sender: event.sender,
    receivedAt: event.receivedAt,
    message: event.message === undefined ? undefined : summarizeMessage(event.message)
  };
}

function summarizeMessage(message: SynapseMessage): Readonly<Record<string, unknown>> {
  const text = message.segments
    .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");

  return {
    id: message.id,
    type: message.type,
    segmentTypes: message.segments.map((segment) => segment.type),
    textLength: text.length,
    textPreview: previewText(text),
    replyTo: message.replyTo
  };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function getText(message: SynapseMessage | undefined): string {
  if (message === undefined) {
    return "";
  }

  return message.segments
    .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");
}

function textMessage(text: string): SynapseMessage {
  return {
    type: "text",
    segments: [{ type: "text", text }]
  };
}

function conservativeResponse(message: SynapseMessage, policy: OutputPolicy): SynapseMessage {
  return {
    ...message,
    segments: [{ type: "text", text: getText(message).slice(0, policy.maxChars) }]
  };
}

function isFreshProcessState(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);

  if (Number.isNaN(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs < 5 * 60 * 1000;
}

function workspaceStoreFromUnknown(value: unknown): WorkspaceStore | undefined {
  if (typeof value !== "object" || value === null || !("resolveWorkspace" in value)) {
    return undefined;
  }

  const candidate = value as { readonly resolveWorkspace?: unknown };
  return typeof candidate.resolveWorkspace === "function" ? value as WorkspaceStore : undefined;
}
