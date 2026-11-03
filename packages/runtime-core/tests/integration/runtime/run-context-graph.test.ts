import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { RuntimeCore } from "../../../src/runtime/runtime-core.js";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import { ConversationRouter, type AgentRequest } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { textMessage } from "@synapse/runtime-protocol";

describe("运行 DAG 集成", () => {
  it("执行轨迹不自动写入 DAG，显式版本与工具调用各自幂等", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    onTestFinished(() => store.close());
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
          schemaVersion: "channel-protocol/v1",
          channelId: "test",
          adapterType: "test",
          observedAt: new Date().toISOString(),
          capabilities: {
            "message.send": { status: "supported", constraints: { targetTypes: ["private", "group"] } },
            "message.media": { status: "unsupported" },
            "message.delete": { status: "unsupported" },
            "file.upload": {
              status: "unsupported",
              constraints: { targetTypes: ["group"], maxFileSizeBytes: 10_485_760 }
            }
          }
        };
      },
      async sendMessage() {
        return { status: "succeeded", messageId: "sent" };
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
      expect(requests[1]!.promptContext!.sections.find((section) => section.id === "context-graph")).toBeUndefined();
      expect(store.contextGraph.getRef(requests[0]!.sessionId, `line:${requests[0]!.lineId}`)).toBeUndefined();
      const toolResults = await store.listEvents(requests[0]!.lineId!, { types: ["tool_result"] });
      expect(toolResults).toHaveLength(2);
      const commit = store.contextGraph.commit({
        scopeId: requests[0]!.sessionId,
        refName: "research",
        expectedVersion: null,
        idempotencyKey: "valuable-result",
        type: "snapshot",
        content: { report: "file-1" }
      });
      expect(store.contextGraph.getRef(requests[0]!.sessionId, "research")?.commitId).toBe(commit.id);
      expect(
        store.contextGraph.commit({
          scopeId: requests[0]!.sessionId,
          refName: "research",
          expectedVersion: null,
          idempotencyKey: "valuable-result",
          type: "snapshot",
          content: { report: "file-1" }
        }).id
      ).toBe(commit.id);
      expect(executions).toBe(2);
    } finally {
      await runtime.dispose();
      store.close();
    }
  });
  it("显式版本使用 CAS 并保持独立作用域", () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    onTestFinished(() => store.close());
    const graph = store.contextGraph;
    const first = graph.commit({
      scopeId: "session-a",
      refName: "decision",
      expectedVersion: null,
      idempotencyKey: "decision-a",
      type: "snapshot",
      content: { decision: "A" }
    });
    const other = graph.commit({
      scopeId: "session-a",
      refName: "independent",
      expectedVersion: null,
      idempotencyKey: "independent",
      type: "snapshot",
      content: { resource: "B" }
    });
    expect(graph.getRef("session-a", "decision")?.commitId).toBe(first.id);
    expect(graph.getRef("session-a", "independent")?.commitId).toBe(other.id);
    expect(graph.getCommit("session-b", first.id)).toBeUndefined();
    graph.commit({
      scopeId: "session-a",
      refName: "decision",
      expectedVersion: 1,
      idempotencyKey: "decision-b",
      type: "snapshot",
      content: { decision: "B" }
    });
    expect(() =>
      graph.commit({
        scopeId: "session-a",
        refName: "decision",
        expectedVersion: 1,
        idempotencyKey: "stale",
        type: "snapshot",
        content: { decision: "stale" }
      })
    ).toThrow(/version conflict/);
    expect(graph.getCommit("session-a", first.id)?.content).toEqual({ decision: "A" });
  });
});
