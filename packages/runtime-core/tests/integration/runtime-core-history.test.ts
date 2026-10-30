import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { ConversationRouter } from "@synapse/runtime-conversation";

import { textMessage } from "@synapse/runtime-protocol";

import {
  createRuntimeFixture,
  MockChannelAdapter,
  RecordingTranscriptStore,
  privateMessage
} from "../helpers/runtime.js";
describe("RuntimeCore 历史与时间上下文", () => {
  it("将最近私聊历史组合到第二次代理请求", async () => {
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
    const runtime = createRuntimeFixture({
      agent,
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

  it("将时区本地时间注入提示词上下文且不改变事件 ISO 时间", async () => {
    const channel = new MockChannelAdapter();
    const observed: Array<{
      time: string | undefined;
      eventReceivedAt: string | undefined;
      eventReceivedAtLocal: string | undefined;
      timezone: string | undefined;
    }> = [];
    const agent: Agent = {
      id: "time-agent",
      async run(request): Promise<AgentRun> {
        observed.push({
          time: request.promptContext?.sections
            .flatMap((section) => section.blocks)
            .find((block) => block.id === "time")?.content,
          eventReceivedAt: request.promptContext?.metadata.eventReceivedAt,
          eventReceivedAtLocal: request.promptContext?.metadata.eventReceivedAtLocal,
          timezone: request.promptContext?.metadata.timezone
        });
        return {
          id: "run-1",
          agentId: "time-agent",
          sessionId: request.sessionId,
          status: "succeeded",
          input: request.input,
          steps: [],
          output: textMessage("ok")
        };
      }
    };
    const runtime = createRuntimeFixture({
      agent,
      context: { timezone: "Asia/Shanghai" }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-time", "what time is it"));

    expect(observed).toHaveLength(1);
    expect(observed[0]?.timezone).toBe("Asia/Shanghai");
    expect(observed[0]?.eventReceivedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(observed[0]?.eventReceivedAtLocal).toContain("GMT+08:00");
    expect(observed[0]?.eventReceivedAtLocal).toMatch(/1970.*08:00:00/);
    expect(observed[0]?.time).toContain('"timezone":"Asia/Shanghai"');
    expect(observed[0]?.time).toContain('"eventReceivedAt":"1970-01-01T00:00:00.000Z"');
  });

  it("按会话存活时间过滤提示词历史", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    await transcriptStore.append({
      sessionId: "qq:unknown:qq-local:private:user-1",
      platform: "qq",
      provider: "unknown",
      channelId: "qq-local",
      conversationType: "private",
      conversationId: "user-1",
      sourceEventId: "old-message",
      role: "user",
      actorId: "guest:qq:unknown:qq-local:user-1",
      text: "old topic",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const observedHistory: string[][] = [];
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention" },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "ttl-agent",
        async run(request): Promise<AgentRun> {
          observedHistory.push(request.promptContext?.messages.map((message) => message.content) ?? []);
          return {
            id: "run-1",
            agentId: "ttl-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      context: { transcriptStore, privateHistoryTtlMinutes: 30 }
    });

    runtime.attachChannel(channel);
    await channel.emit({ ...privateMessage("event-ttl", "hi"), receivedAt: "2026-07-05T00:00:00.000Z" });

    expect(observedHistory).toEqual([[]]);
  });
});
