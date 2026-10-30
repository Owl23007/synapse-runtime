import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { buildSourceEventId } from "../../src/index.js";
import {
  createRuntimeFixture,
  MockChannelAdapter,
  FailFirstAssistantTranscriptStore,
  RecordingEventProcessStore,
  groupMessage,
  privateMessage
} from "../helpers/runtime.js";
describe("RuntimeCore 幂等与交付恢复", () => {
  it("已完成的重复源事件不再调用代理", async () => {
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
    const runtime = createRuntimeFixture({
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

  it("使用注入的事件处理存储维护幂等状态", async () => {
    const channel = new MockChannelAdapter();
    const eventProcessStore = new RecordingEventProcessStore();
    const agent: Agent = {
      id: "event-process-agent",
      async run(request): Promise<AgentRun> {
        return {
          id: "run-1",
          agentId: "event-process-agent",
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
      context: { providerByChannelId: { "qq-local": "napcat" }, eventProcessStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(eventProcessStore.begins).toEqual([
      {
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        sourceEventType: "message.created"
      }
    ]);
    expect(eventProcessStore.updates.map((update) => update.status)).toEqual([
      undefined,
      "processing",
      "agent_completed",
      undefined,
      "processing",
      "send_succeeded",
      "completed"
    ]);
  });

  it("为基于时钟生成的事件标识推导尽可能稳定的源事件标识", async () => {
    const first = {
      ...privateMessage("qq-local:message:private:1700000000000", "hello"),
      message: textMessage("hello")
    };
    const duplicate = {
      ...first,
      id: "qq-local:message:private:1700000000001"
    };
    const distinctMessage = {
      ...duplicate,
      id: "qq-local:message:private:1700000000002",
      receivedAt: new Date(1_000).toISOString()
    };

    expect(buildSourceEventId(first, "napcat")).toEqual(buildSourceEventId(duplicate, "napcat"));
    expect(buildSourceEventId(first, "napcat")).toMatch(/^best-effort:/);
    expect(buildSourceEventId(first, "napcat")).not.toEqual(buildSourceEventId(distinctMessage, "napcat"));
  });

  it("去重生成标识的精确重放且不合并后续同文消息", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "best-effort-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: `run-${runCount}`,
          agentId: "best-effort-agent",
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
      context: { providerByChannelId: { "qq-local": "napcat" } }
    });
    const first = {
      ...privateMessage("qq-local:message:private:1700000000000", "hello"),
      message: textMessage("hello")
    };
    const duplicate = {
      ...first,
      id: "qq-local:message:private:1700000000001"
    };
    const distinctMessage = {
      ...duplicate,
      id: "qq-local:message:private:1700000000002",
      receivedAt: new Date(1_000).toISOString()
    };

    runtime.attachChannel(channel);
    await channel.emit(first);
    await channel.emit(duplicate);
    await channel.emit(distinctMessage);

    expect(runCount).toBe(2);
    expect(channel.sent).toHaveLength(2);
  });

  it("重试发送失败的重复事件且不再次调用代理", async () => {
    const channel = new MockChannelAdapter();
    channel.sendResults.push({ status: "failed", error: "network down" }, { status: "succeeded", messageId: "sent-2" });
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
    const runtime = createRuntimeFixture({
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

  it("发送成功后补齐缺失助手转录且不重发", async () => {
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
    const runtime = createRuntimeFixture({
      agent,
      context: { providerByChannelId: { "qq-local": "napcat" }, transcriptStore }
    });
    const event = privateMessage("event-1", "first");

    runtime.attachChannel(channel);
    await channel.emit(event);
    await channel.emit(event);
    await channel.emit(privateMessage("event-2", "second"));

    expect(runCount).toBe(2);
    expect(channel.sent).toHaveLength(2);
    expect(observedHistory[0]).toEqual([]);
    expect(observedHistory[1]?.[0]).toBe("[1970-01-01T00:00:00.000Z] first");
    expect(observedHistory[1]?.[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] reply-event-1$/);
  });
});
