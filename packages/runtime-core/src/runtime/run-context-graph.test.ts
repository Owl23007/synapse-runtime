import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import { RunContextGraph } from "./run-context-graph.js";
import { RuntimeCore } from "./runtime-core.js";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import { ConversationRouter, type AgentRequest } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { textMessage } from "@synapse/runtime-protocol";

describe("Run DAG integration", () => {
  it("通过真实运行时记录工具结果并在下一轮读取 DAG，重复入站不重放工具", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    const requests: AgentRequest[] = [];
    let executions = 0;
    const tools = new ToolRuntime(
      new StaticPermissionEngine({ "test.work": "allow", "channel.qq.send_group_message": "allow" })
    );
    tools.register({
      name: "test.work",
      description: "生成工件",
      permission: { action: "test.work", resource: "test" },
      async handle() {
        executions += 1;
        return { artifacts: [{ id: "file-1", name: "report.csv" }], stdout: "不要进入历史的日志" };
      }
    });
    const channels = new InMemoryChannelRegistry();
    const runtime = new RuntimeCore({
      channels,
      tools,
      conversation: new ConversationRouter({
        groupTrigger: { mode: "always" },
        privateTrigger: { mode: "always" },
        contextPolicy: { includeHistory: true, maxMessages: 10 }
      }),
      agent: {
        id: "test",
        async run(request, context) {
          requests.push(request);
          await context!.tools.call("test.work", {}, { runId: request.event.id });
          return {
            id: request.event.id,
            agentId: "test",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            output: textMessage("已生成报告")
          };
        }
      },
      context: { graph: store.contextGraph, conversationStore: store, transcriptStore: store, eventProcessStore: store }
    });
    const channel: ChannelAdapter = {
      id: "test",
      type: "onebot11",
      provider: "napcat",
      async connect() {},
      async disconnect() {},
      onEvent() {},
      async getStatus() {
        return { state: "online", checkedAt: "" };
      },
      getCapabilities() {
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
      },
      async sendMessage() {
        return { ok: true, messageId: "sent" };
      }
    };
    runtime.attachChannel(channel);
    const event = {
      id: "one",
      platform: "qq" as const,
      channelId: "test",
      eventType: "message.created" as const,
      conversation: { id: "group", kind: "group" as const },
      sender: { id: "user" },
      message: textMessage("生成报告"),
      receivedAt: new Date().toISOString()
    };
    try {
      await runtime.handleChannelEvent(event, "napcat");
      await runtime.handleChannelEvent(event, "napcat");
      await runtime.handleChannelEvent({ ...event, id: "two", message: textMessage("继续") }, "napcat");
      expect(executions).toBe(2);
      const history = requests[1]!.promptContext!.sections.find((section) => section.id === "context-graph")!;
      expect(JSON.stringify(history)).toContain("file-1");
      expect(JSON.stringify(history)).not.toContain("不要进入历史的日志");
      expect(
        store.contextGraph
          .resolveContextPath(requests[0]!.sessionId, `line:${requests[0]!.lineId}`)
          .commits.filter((c) => c.type === "result")
      ).toHaveLength(2);
    } finally {
      await runtime.dispose();
      store.close();
    }
  });
  it("保留反序完成的并发运行并隔离其他群，重复回流不会倒退指针", () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    try {
      const graph = store.contextGraph;
      const runs = new RunContextGraph(graph, 6000);
      runs.begin("group-a", "main", "slow", "生成报告", "user");
      runs.begin("group-a", "main", "fast", "生成表格", "user");
      runs.record("group-a", "slow", "tool-1", "tool_result", {
        name: "container.run",
        status: "succeeded",
        artifacts: [{ id: "artifact-1", name: "report.md" }]
      });
      runs.finish("group-a", "main", "fast", "表格已完成");
      const first = graph.getRef("group-a", "line:main")!;
      runs.finish("group-a", "main", "slow", "报告已上传");
      const final = graph.getRef("group-a", "line:main")!;
      const merge = graph.getCommit("group-a", final.commitId)!;
      expect(merge.parents[0]).toBe(first.commitId);
      expect(merge.parents).toHaveLength(2);
      const path = graph.resolveContextPath("group-a", "line:main");
      expect(path.commits.filter((c) => c.type === "result").map((c) => c.content.output)).toEqual([
        "表格已完成",
        "报告已上传"
      ]);
      expect(JSON.stringify(runs.compose("group-a", "main", undefined))).toContain("artifact-1");
      expect(runs.compose("group-b", "main", undefined)).toBeUndefined();
      // 新实例模拟重启，已完成的幂等回执不会以新的版本再次提交
      const recovered = new RunContextGraph(graph, 6000);
      recovered.begin("group-a", "main", "slow", "生成报告", "user");
      recovered.finish("group-a", "main", "slow", "报告已上传");
      expect(graph.getRef("group-a", "line:main")).toEqual(final);
      expect(graph.getCommitByKey("group-b", "run:slow:result")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("运行结果在回流之前不影响对话上下文，读取遵守有限回溯预算", () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    try {
      const runs = new RunContextGraph(store.contextGraph, 500);
      runs.begin("group", "main", "event", "输入", "user");
      runs.record("group", "event", "large", "tool_result", { output: "private-running-result".repeat(100) });
      expect(JSON.stringify(runs.compose("group", "main", undefined))).not.toContain("private-running-result");
      runs.finish("group", "main", "event", "已完成");
      const prompt = runs.compose("group", "main", undefined)!;
      expect(prompt.metadata.contextGraphHead).toBe(store.contextGraph.getRef("group", "line:main")!.commitId);
      expect(JSON.parse(prompt.sections[0]!.blocks[0]!.content).truncated).toBe(true);
    } finally {
      store.close();
    }
  });
});
