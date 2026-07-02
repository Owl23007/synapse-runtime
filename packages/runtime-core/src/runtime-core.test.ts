import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import {
  InMemoryChannelRegistry,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelEventHandler,
  type ChannelStatus,
  type ChannelTarget,
  type SendResult
} from "@synapse/runtime-channel";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { InMemoryTranscriptStore, RuntimeCore, type TranscriptAppendInput } from "./index.js";

class MockChannelAdapter implements ChannelAdapter {
  readonly id = "qq-local";
  readonly type = "onebot11";
  readonly provider = "napcat";
  readonly #handlers = new Set<ChannelEventHandler>();
  readonly sent: Array<{ target: ChannelTarget; message: SynapseMessage }> = [];
  readonly sendResults: SendResult[] = [];

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getStatus(): Promise<ChannelStatus> {
    return { state: "online", checkedAt: new Date(0).toISOString() };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      receivePrivateMessage: true,
      receiveGroupMessage: true,
      receiveAllGroupMessages: true,
      requiresMention: false,
      sendPrivateMessage: true,
      sendGroupMessage: true,
      sendMedia: false,
      manageGroup: false,
      recallMessage: false,
      complianceLevel: "community",
      riskLevel: "high"
    };
  }

  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    this.sent.push({ target, message });
    return this.sendResults.shift() ?? { ok: true, messageId: "sent-1" };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async emit(event: SynapseChannelEvent): Promise<void> {
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
  }
}

class FailFirstAssistantTranscriptStore extends InMemoryTranscriptStore {
  #failed = false;

  override async append(input: TranscriptAppendInput) {
    if (input.role === "assistant" && !this.#failed) {
      this.#failed = true;
      throw new Error("transcript write failed");
    }

    return super.append(input);
  }
}

describe("RuntimeCore", () => {
  it("routes channel events through conversation policy before invoking the agent", async () => {
    const channel = new MockChannelAdapter();
    const toolRuntime = new ToolRuntime(
      new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })
    );
    const runs: AgentRun[] = [];
    const agent: Agent = {
      id: "echo-agent",
      async run(request): Promise<AgentRun> {
        const run = {
          id: "run-1",
          agentId: "echo-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        } satisfies AgentRun;
        runs.push(run);
        return run;
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "keyword", keywords: ["Synapse"] },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: toolRuntime
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "hello"));
    await channel.emit(groupMessage("event-2", "Synapse ping"));

    expect(runs).toHaveLength(1);
    expect(channel.sent).toEqual([
      {
        target: { type: "group", groupId: "group-1" },
        message: {
          ...textMessage("ok"),
          replyTo: {
            eventId: "event-2"
          }
        }
      }
    ]);
    expect(runtime.traces).toEqual([
      { eventId: "event-1", status: "ignored", reason: "not_triggered" },
      { eventId: "event-2", status: "succeeded", runId: "run-1" }
    ]);
  });

  it("blocks channel replies when the send permission is not allowed", async () => {
    const channel = new MockChannelAdapter();
    const agent: Agent = {
      id: "echo-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "echo-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "confirm" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "Synapse ping"));

    expect(channel.sent).toEqual([]);
    expect(runtime.traces).toEqual([
      {
        eventId: "event-1",
        status: "blocked",
        reason: 'Permission decision was "confirm".',
        runId: "run-1"
      }
    ]);
  });

  it("composes recent private history into the second agent request", async () => {
    const channel = new MockChannelAdapter();
    const observedHistory: number[] = [];
    const agent: Agent = {
      id: "history-agent",
      async run(request): Promise<AgentRun> {
        observedHistory.push(request.promptContext?.messages.length ?? 0);
        return {
          id: `run-${request.event.id}`,
          agentId: "history-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`reply-${request.event.id}`)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "first"));
    await channel.emit(privateMessage("event-2", "second"));

    expect(observedHistory).toEqual([0, 2]);
    expect(channel.sent.map((sent) => sent.message.segments[0])).toEqual([
      { type: "text", text: "reply-event-1" },
      { type: "text", text: "reply-event-2" }
    ]);
  });

  it("does not call the agent again for completed duplicate source events", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "dedupe-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${request.event.id}-${runCount}`,
          agentId: "dedupe-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const event = groupMessage("event-1", "Synapse ping");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(runtime.traces.at(-1)).toEqual({ eventId: "event-1", status: "ignored", reason: "duplicate_completed" });
  });

  it("retries a send_failed duplicate without calling the agent again", async () => {
    const channel = new MockChannelAdapter();
    channel.sendResults.push({ ok: false, error: "network down" }, { ok: true, messageId: "sent-2" });
    let runCount = 0;
    const agent: Agent = {
      id: "retry-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${runCount}`,
          agentId: "retry-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("retry me")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const event = groupMessage("event-1", "Synapse ping");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);

    expect(runCount).toBe(1);
    expect(channel.sent).toHaveLength(2);
    expect(runtime.traces).toEqual([
      { eventId: "event-1", status: "failed", reason: "network down", runId: "run-1" },
      { eventId: "event-1", status: "succeeded", runId: "recovered-event-1" }
    ]);
  });

  it("fills missing assistant transcript after send_succeeded without resending", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new FailFirstAssistantTranscriptStore();
    let runCount = 0;
    const observedHistory: string[][] = [];
    const agent: Agent = {
      id: "recover-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        observedHistory.push(request.promptContext?.messages.map((message) => message.content) ?? []);
        return {
          id: `run-${request.event.id}`,
          agentId: "recover-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`reply-${request.event.id}`)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" })),
      context: { providerByChannelId: { "qq-local": "napcat" }, transcriptStore }
    });
    const event = privateMessage("event-1", "first");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);
    await channel.emit(privateMessage("event-2", "second"));

    expect(runCount).toBe(2);
    expect(channel.sent).toHaveLength(2);
    expect(observedHistory).toEqual([[], ["first", "reply-event-1"]]);
  });

  it("applies concise response policy in group workspaces", async () => {
    const channel = new MockChannelAdapter();
    const agent: Agent = {
      id: "long-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "long-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage(`# Title\n\n**${"x".repeat(700)}**\n\n\`\`\`ts\nconsole.log("hidden")\n\`\`\``)
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "Synapse ping"));

    const text = sentText(channel.sent[0]?.message);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("```");
    expect(text).not.toContain("**");
    expect(text).toContain("内容较长，需要我展开再说。");
  });

  it("handles workspace info without invoking the agent", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "unused-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: "run-1",
          agentId: "unused-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("unused")
        };
      }
    };
    const runtime = new RuntimeCore({
      channels: new InMemoryChannelRegistry(),
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_private_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/workspace info"));

    expect(runCount).toBe(0);
    expect(channel.sent[0]?.message.segments[0]).toEqual({
      type: "text",
      text: expect.stringContaining("workspaceType=personal")
    });
  });
});

function groupMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "group-1", kind: "group" },
    sender: { id: "user-1" },
    message: textMessage(text),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

function privateMessage(id: string, text: string): SynapseChannelEvent {
  return {
    id,
    platform: "qq",
    channelId: "qq-local",
    eventType: "message.created",
    conversation: { id: "user-1", kind: "private" },
    sender: { id: "user-1" },
    message: textMessage(text, id),
    raw: {},
    receivedAt: new Date(0).toISOString()
  };
}

function sentText(message: SynapseMessage | undefined): string {
  return (
    message?.segments
      .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
      .map((segment) => segment.text)
      .join("") ?? ""
  );
}
