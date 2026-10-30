import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";

import { ConversationRouter } from "@synapse/runtime-conversation";

import { textMessage } from "@synapse/runtime-protocol";

import { createRuntimeFixture, MockChannelAdapter, privateMessage, sentText } from "../helpers/runtime.js";
describe("RuntimeCore 内置命令", () => {
  it("默认将命令触发标记为单轮", () => {
    const router = new ConversationRouter({
      groupTrigger: { mode: "mention_or_keyword", commandPrefixes: ["/"], allowCommandWithoutMention: true },
      privateTrigger: { mode: "always", commandPrefixes: ["/"] },
      contextPolicy: { includeHistory: true, maxMessages: 20 }
    });

    const decision = router.route(privateMessage("event-command", "/whoami"));

    expect(decision.reason).toBe("command_prefix");
    expect(decision.request?.contextPolicy.includeHistory).toBe(false);
    expect(decision.request?.trigger).toEqual({
      kind: "command",
      confidence: "explicit",
      reason: "command_prefix"
    });
  });

  it("处理工作区信息命令且不调用代理", async () => {
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
    const runtime = createRuntimeFixture({
      agent
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/workspace info"));

    expect(runCount).toBe(0);
    expect(channel.sent[0]?.message.segments[0]).toEqual({
      type: "text",
      text: expect.stringContaining("workspaceType=personal")
    });
  });

  it("帮助命令列出已注册命令且不调用代理", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const runtime = createRuntimeFixture({
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          runCount += 1;
          throw new Error("agent should not be called");
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/help"));

    expect(runCount).toBe(0);
    expect(sentText(channel.sent[0]?.message)).toBe(
      [
        "可用指令：",
        "/help - 查看所有可用指令",
        "/whoami - 查看当前身份",
        "/workspace info - 查看当前工作区",
        "/workspace use project:<id> - 切换到项目工作区",
        "/branches - 查看当前会话分支",
        "/tasks - 查看当前会话任务",
        "/memory <remember|list|delete> - 管理长期记忆"
      ].join("\n")
    );
  });

  it("通过注册命令查询当前会话分支与任务", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const runtime = createRuntimeFixture({
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          runCount += 1;
          throw new Error("agent should not be called");
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-seed", "/help"));
    const sessionId = "qq:napcat:qq-local:private:user-1";
    const mainline = await runtime.conversationStore.getMainline(sessionId);
    const sourceEvent = (await runtime.conversationStore.listEvents(mainline.id))[0];
    const branch = await runtime.createBranch({
      sessionId,
      sourceEventId: sourceEvent?.id ?? "",
      title: "Inspect parser",
      goal: "Find parser bottleneck",
      reason: "Can run independently",
      createdBy: "test",
      idempotencyKey: "branch-command-query"
    });
    const task = await runtime.conversationStore.createTask(branch.id, {
      executor: "repository-analyzer",
      input: { path: "src/parser.ts" },
      idempotencyKey: "task-command-query"
    });

    await channel.emit(privateMessage("event-branches", "/branches"));
    await channel.emit(privateMessage("event-tasks", "/tasks"));

    expect(runCount).toBe(0);
    expect(sentText(channel.sent[1]?.message)).toContain(`- ${branch.id} [created] Inspect parser`);
    expect(sentText(channel.sent[2]?.message)).toContain(`- ${task.id} [pending] executor=repository-analyzer`);
  });

  it("默认返回持久记忆未启用消息", async () => {
    const channel = new MockChannelAdapter();
    let runCount = 0;
    const runtime = createRuntimeFixture({
      agent: {
        id: "unused-agent",
        async run(): Promise<AgentRun> {
          runCount += 1;
          throw new Error("agent should not be called");
        }
      }
    });

    runtime.attachChannel(channel);
    await channel.emit(privateMessage("event-1", "/memory remember 我喜欢简短回答"));

    expect(runCount).toBe(0);
    expect(channel.sent[0]?.message.segments[0]).toEqual({
      type: "text",
      text: "当前未启用长期记忆。你的消息只会作为当前会话历史使用。"
    });
  });
});
