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
import { RuntimeCore } from "./index.js";

class MockChannelAdapter implements ChannelAdapter {
  readonly id = "qq-local";
  readonly type = "onebot11";
  readonly provider = "napcat";
  readonly #handlers = new Set<ChannelEventHandler>();
  readonly sent: Array<{ target: ChannelTarget; message: SynapseMessage }> = [];

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
    return { ok: true, messageId: "sent-1" };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async emit(event: SynapseChannelEvent): Promise<void> {
    await Promise.all([...this.#handlers].map((handler) => handler(event)));
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
