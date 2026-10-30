import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";

import {
  createRuntimeFixture,
  MockChannelAdapter,
  FailingConversationStore,
  FailingEventProcessStore,
  failingIdentityResolver,
  groupMessage,
  privateMessage,
  sentText
} from "../helpers/runtime.js";
describe("RuntimeCore 权限与失败边界", () => {
  it.each(["qq", "discord", "cli"] as const)("根据规范事件平台 %s 检查权限并执行统一发送动作", async (platform) => {
    const channel = new MockChannelAdapter();
    const runtime = createRuntimeFixture({
      agent: {
        id: "platform-agent",
        async run(request): Promise<AgentRun> {
          return {
            id: "platform-run",
            agentId: "platform-agent",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("delivered")
          };
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ [`channel.${platform}.send_private_message`]: "allow" }))
    });
    {
      runtime.attachChannel(channel);
      await channel.emit({ ...privateMessage("platform-event", "hello"), platform });
      expect(channel.sent).toHaveLength(1);
      expect(runtime.traces.at(-1)?.status).toBe("succeeded");
    }
  });

  it("代理运行失败时发送安全的本地化消息", async () => {
    const channel = new MockChannelAdapter();
    const runtime = createRuntimeFixture({
      agent: {
        id: "failing-agent",
        async run(request): Promise<AgentRun> {
          return {
            id: "run-failed",
            agentId: "failing-agent",
            sessionId: request.sessionId,
            status: "failed",
            input: request.input,
            steps: [],
            error: "provider secret response"
          };
        }
      },
      localize: (key) => (key === "agent.request_failed" ? "模型请求失败，请稍后重试。" : key)
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-failed", "你好"));

    expect(sentText(channel.sent[0]?.message)).toBe("模型请求失败，请稍后重试。");
    expect(sentText(channel.sent[0]?.message)).not.toContain("provider secret response");
  });

  it("发送权限未获允许时阻止通道回复", async () => {
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
    const runtime = createRuntimeFixture({
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

  it("身份解析失败时回退到访客身份", async () => {
    const channel = new MockChannelAdapter();
    const observedUserIds: string[] = [];
    const agent: Agent = {
      id: "identity-fallback-agent",
      async run(request): Promise<AgentRun> {
        observedUserIds.push(request.userId);
        return {
          id: "run-1",
          agentId: "identity-fallback-agent",
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
      context: { providerByChannelId: { "qq-local": "napcat" }, identityResolver: failingIdentityResolver }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(observedUserIds).toEqual(["guest:qq:napcat:qq-local:user-1"]);
    expect(channel.sent).toHaveLength(1);
  });

  it("工作区解析失败时回退到默认工作区", async () => {
    const channel = new MockChannelAdapter();
    const runtime = createRuntimeFixture({
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          throw new Error("agent should not be called");
        }
      },
      tools: new ToolRuntime(new StaticPermissionEngine({ "channel.qq.send_group_message": "allow" })),
      context: {
        providerByChannelId: { "qq-local": "napcat" },
        workspaceResolver: {
          async resolve() {
            throw new Error("workspace unavailable");
          }
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit(groupMessage("event-1", "/workspace info"));

    expect(sentText(channel.sent[0]?.message)).toContain("workspaceId=group:qq:qq-local:group-1");
  });

  it("幂等恢复持久化失败时不启动代理", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const agent: Agent = {
      id: "no-idempotency-agent",
      async run(request): Promise<AgentRun> {
        runCount += 1;
        return {
          id: "run-1",
          agentId: "no-idempotency-agent",
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
      context: { eventProcessStore: new FailingEventProcessStore() }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(runCount).toBe(0);
    expect(channel.sent).toHaveLength(0);
    expect(runtime.traces).toEqual([{ eventId: "event-1", status: "failed", reason: "idempotency unavailable" }]);
  });

  it("规范事件持久化失败时不路由、不运行且不发送", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const runtime = createRuntimeFixture({
      agent: {
        id: "must-not-run",
        async run(request): Promise<AgentRun> {
          runCount += 1;
          return {
            id: "run-1",
            agentId: "must-not-run",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("unexpected")
          };
        }
      },
      context: { conversationStore: new FailingConversationStore() }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "hello"));

    expect(runCount).toBe(0);
    expect(channel.sent).toHaveLength(0);
    expect(runtime.traces).toEqual([
      {
        eventId: "event-1",
        status: "failed",
        reason: "persistence_failed: conversation persistence unavailable"
      }
    ]);
  });

  it("在群工作区应用简洁回复策略", async () => {
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
    const runtime = createRuntimeFixture({
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
});
