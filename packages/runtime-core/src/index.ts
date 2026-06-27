import type { Agent, AgentRuntimeContext } from "@synapse/runtime-agent-core";
import type { ChannelAdapter, ChannelRegistry, ChannelTarget } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter } from "@synapse/runtime-conversation";
import type { SynapseChannelEvent, SynapseMessage } from "@synapse/runtime-protocol";
import type { ToolRuntime } from "@synapse/runtime-tool-runtime";

export interface RuntimeCoreOptions {
  readonly channels: ChannelRegistry;
  readonly conversation: ConversationRouter;
  readonly agent: Agent;
  readonly tools: ToolRuntime;
  readonly logger?: RuntimeCoreLogger;
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
  readonly #traces: RuntimeTrace[] = [];

  constructor(options: RuntimeCoreOptions) {
    this.#channels = options.channels;
    this.#conversation = options.conversation;
    this.#agent = options.agent;
    this.#tools = options.tools;
    this.#logger = options.logger;
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
    try {
      const context: AgentRuntimeContext = { tools: this.#tools };
      this.#logger?.info("Runtime agent run started.", {
        eventId: event.id,
        agentId: this.#agent.id,
        sessionId: request.sessionId,
        userId: request.userId,
        input: summarizeMessage(request.input)
      });
      const run = await this.#agent.run(request, context);
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
        const channel = this.#channels.get(event.channelId);
        const target = targetFromEvent(event);

        if (channel === undefined) {
          this.#traces.push({ eventId: event.id, status: "failed", reason: `Channel "${event.channelId}" is not registered.` });
          this.#logger?.error("Runtime send failed because channel is not registered.", {
            eventId: event.id,
            runId: run.id,
            channelId: event.channelId
          });
          return;
        }

        this.#logger?.info("Runtime checking send permission.", {
          eventId: event.id,
          runId: run.id,
          action: channelSendAction(target),
          target
        });
        const permission = await this.#tools.decidePermission({
          action: channelSendAction(target),
          resource: `${event.platform}:${event.channelId}:${event.conversation.id}`,
          subject: request.userId,
          metadata: {
            eventId: event.id,
            runId: run.id,
            conversationKind: event.conversation.kind
          }
        });
        this.#logger?.info("Runtime send permission decided.", {
          eventId: event.id,
          runId: run.id,
          action: permission.action,
          resource: permission.resource,
          decision: permission.decision,
          reason: permission.reason
        });

        if (permission.decision !== "allow") {
          this.#traces.push({
            eventId: event.id,
            status: "blocked",
            reason: permission.reason ?? `Permission decision was "${permission.decision}".`,
            runId: run.id
          });
          this.#logger?.warn("Runtime blocked channel reply.", {
            eventId: event.id,
            runId: run.id,
            decision: permission.decision,
            reason: permission.reason ?? `Permission decision was "${permission.decision}".`
          });
          return;
        }

        this.#logger?.info("Runtime sending channel reply.", {
          eventId: event.id,
          runId: run.id,
          channelId: channel.id,
          target,
          output: summarizeMessage(run.output)
        });
        const result = await channel.sendMessage(target, withReplyContext(run.output, event));

        if (!result.ok) {
          this.#traces.push({ eventId: event.id, status: "failed", reason: result.error ?? "Channel send failed.", runId: run.id });
          this.#logger?.error("Runtime channel reply failed.", {
            eventId: event.id,
            runId: run.id,
            channelId: channel.id,
            target,
            error: result.error ?? "Channel send failed."
          });
          return;
        }
        this.#logger?.info("Runtime channel reply sent.", {
          eventId: event.id,
          runId: run.id,
          channelId: channel.id,
          target,
          messageId: result.messageId
        });
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
