import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { InMemoryTranscriptStore } from "../../src/index.js";
import {
  createRuntimeFixture,
  MockChannelAdapter,
  RecordingTranscriptStore,
  RecordingConversationStore,
  groupMessage,
  groupMessageWithSegments,
  privateMessage
} from "../helpers/runtime.js";
describe("RuntimeCore 路由与群触发", () => {
  it("调用代理前根据会话策略路由通道事件", async () => {
    const channel = new MockChannelAdapter();
    const toolRuntime = new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" }));
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
    const runtime = createRuntimeFixture({
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

  it("持久化前归属入站事件并记录路由决策", async () => {
    const channel = new MockChannelAdapter();
    const conversationStore = new RecordingConversationStore();
    const transcriptStore = new InMemoryTranscriptStore();
    const sessionId = "qq:napcat:qq-local:private:user-1";
    const seed = await conversationStore.acceptNormalizedEvent({
      sessionId,
      platform: "qq",
      provider: "napcat",
      channelId: "qq-local",
      conversationType: "private",
      conversationId: "user-1",
      sourceEventId: "seed-message",
      sourceEventType: "message.created",
      senderId: "user-1",
      text: "创建分支",
      receivedAt: "2026-07-27T12:00:00.000Z",
      idempotencyKey: "accept-seed-message"
    });
    const branch = await conversationStore.createBranch({
      id: "branch-runtime-attribution",
      sessionId,
      sourceEventId: seed.lineEvent.id,
      title: "运行时归属",
      goal: "验证消息先归属再执行",
      reason: "入口路由测试",
      createdBy: "agent",
      idempotencyKey: "create-branch-runtime-attribution"
    });
    let observedLineId: string | undefined;
    const agent: Agent = {
      id: "attribution-agent",
      async run(request): Promise<AgentRun> {
        observedLineId = request.lineId;
        return {
          id: "run-attribution",
          agentId: "attribution-agent",
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
      context: {
        conversationStore,
        transcriptStore,
        attributor: {
          async attribute() {
            return {
              sessionId,
              nature: "task_followup",
              action: "resume",
              targetLineId: branch.id,
              confidence: 0.97,
              reasons: ["test_target"],
              candidates: [
                {
                  lineId: branch.id,
                  score: 0.97,
                  signals: ["test_target"]
                }
              ]
            };
          }
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit({
      ...privateMessage("event-attribution", "继续"),
      receivedAt: "2026-07-27T12:01:00.000Z"
    });

    expect(observedLineId).toBe(branch.id);
    expect(conversationStore.accepted.at(-1)?.targetLineId).toBe(branch.id);
    expect(await conversationStore.listEvents(branch.id, { types: ["context_attributed"] })).toEqual([
      expect.objectContaining({
        sourceEventId: expect.any(String),
        payload: {
          action: "resume",
          nature: "task_followup",
          targetLineId: branch.id,
          confidence: 0.97,
          reasons: ["test_target"],
          candidates: [
            {
              lineId: branch.id,
              score: 0.97,
              signals: ["test_target"]
            }
          ]
        }
      })
    ]);
  });

  it("不持久化或投影未触发的群消息", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    const conversationStore = new RecordingConversationStore();
    const agent: Agent = {
      id: "unused-agent",
      async run(request): Promise<AgentRun> {
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
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "keyword", keywords: ["Synapse"] },
        privateTrigger: { mode: "always" }
      }),
      agent,
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore, conversationStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "ordinary group message"));

    expect(transcriptStore.appends).toEqual([]);
    expect(conversationStore.accepted).toHaveLength(0);
    expect(channel.sent).toEqual([]);
  });

  it("后续群消息触发代理时排除先前未触发的群消息", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new InMemoryTranscriptStore();
    let observedHistory: readonly { readonly content: string }[] = [];
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "keyword", keywords: ["Synapse"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "group-history-agent",
        async run(request): Promise<AgentRun> {
          observedHistory = request.promptContext?.messages ?? [];
          return {
            id: "group-history-run",
            agentId: "group-history-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("history-event-1", "ordinary group context"));
    await channel.emit(groupMessage("history-event-2", "Synapse, respond now"));

    expect(observedHistory).toEqual([]);
    expect(channel.sent).toHaveLength(1);
  });

  it("不持久化提及他人或全体成员的群消息", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    let runCount = 0;
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "mention-agent",
        async run(request): Promise<AgentRun> {
          runCount += 1;
          return {
            id: `run-${request.event.id}`,
            agentId: "mention-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit(
      groupMessageWithSegments("event-other", [
        { type: "mention", target: "user", userId: "user-2" },
        { type: "text", text: " hi" }
      ])
    );
    await channel.emit(
      groupMessageWithSegments("event-all", [
        { type: "mention", target: "all" },
        { type: "text", text: " hi" }
      ])
    );

    expect(runCount).toBe(0);
    expect(transcriptStore.appends).toEqual([]);
    expect(runtime.traces).toEqual([
      { eventId: "event-other", status: "ignored", reason: "mentioned_other_user" },
      { eventId: "event-all", status: "ignored", reason: "mention_all" }
    ]);
  });

  it("仅在提及对象为机器人时触发群提及", async () => {
    const channel = new MockChannelAdapter();
    const observedReasons: string[] = [];
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "mention-bot-agent",
        async run(request): Promise<AgentRun> {
          observedReasons.push(request.trigger?.reason ?? "missing");
          return {
            id: "run-1",
            agentId: "mention-bot-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" }))
    });

    runtime.attachChannel(channel);
    await channel.emit(
      groupMessageWithSegments("event-bot", [
        { type: "mention", target: "user", userId: "bot-1" },
        { type: "text", text: " hi" }
      ])
    );

    expect(observedReasons).toEqual(["mentioned_bot"]);
    expect(channel.sent).toHaveLength(1);
  });

  it("匹配规范化外部消息标识以触发回复机器人", async () => {
    const channel = new MockChannelAdapter();
    const transcriptStore = new RecordingTranscriptStore();
    await transcriptStore.append({
      sessionId: "qq:napcat:qq-local:group:group-1",
      platform: "qq",
      provider: "napcat",
      channelId: "qq-local",
      conversationType: "group",
      conversationId: "group-1",
      sourceEventId: "assistant-1",
      role: "assistant",
      text: "previous bot reply",
      externalMessageId: "42",
      createdAt: new Date(0).toISOString()
    });
    const observedReasons: string[] = [];
    const runtime = createRuntimeFixture({
      conversation: new ConversationRouter({
        groupTrigger: { mode: "mention", botUserIds: ["bot-1"] },
        privateTrigger: { mode: "always" }
      }),
      agent: {
        id: "reply-agent",
        async run(request): Promise<AgentRun> {
          observedReasons.push(request.trigger?.reason ?? "missing");
          return {
            id: "run-1",
            agentId: "reply-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("ok")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: { transcriptStore }
    });

    runtime.attachChannel(channel);
    await channel.emit({
      ...groupMessage("event-reply", "continue"),
      message: { ...textMessage("continue"), replyTo: { messageId: "42" } },
      adapterCapabilities: { replyToBot: "yes", incomingReplyTarget: true }
    });

    expect(observedReasons).toEqual(["reply_to_bot"]);
    expect(channel.sent).toHaveLength(1);
  });
});
