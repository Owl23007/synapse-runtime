import { describe, expect, it, onTestFinished, vi } from "vitest";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { RuntimeCore } from "../../../src/runtime/runtime-core.js";
import { RuntimeWorkspace } from "../../../src/runtime/workspace.js";
import { createExecutionTools } from "../../../src/execution/tools.js";
import { nextScheduleTime } from "../../../src/execution/time.js";
import { allocateContext } from "../../../src/context/budget.js";
import { MockChannelAdapter } from "../../helpers/runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(
  options: {
    agent?: Agent;
    maxRunsPerGrant?: number;
    maxAttempts?: number;
    maxModelCallsPerRun?: number;
    maxToolCallsPerRun?: number;
    allowNotify?: boolean;
    retentionHours?: number;
  } = {}
) {
  const store = new SqliteRuntimeContextStore({
    databasePath: ":memory:",
    autonomy: {
      maxRunsPerGrant: options.maxRunsPerGrant ?? 24,
      maxAttempts: options.maxAttempts ?? 3,
      maxModelCallsPerRun: options.maxModelCallsPerRun ?? 8,
      maxToolCallsPerRun: options.maxToolCallsPerRun ?? 16,
      retentionHours: options.retentionHours ?? 168
    }
  });
  await store.bindProjectWorkspace({ workspaceId: "project", identityId: "principal" });
  const grant = store.execution.issueGrant({
    key: "root",
    workspaceId: "project",
    principalId: "principal",
    source: {
      platform: "qq",
      provider: "napcat",
      channelId: "qq-local",
      conversationId: "group",
      conversationKind: "group"
    }
  });
  const tools = new ToolRuntime(
    new StaticPermissionEngine({
      "runtime.manage": "allow",
      "test.effect": "allow",
      "channel.qq.send_group_message": options.allowNotify === false ? "deny" : "allow"
    })
  );
  for (const tool of createExecutionTools(store.execution, store.contextGraph)) tools.register(tool);
  const agent: Agent = options.agent ?? {
    id: "test",
    async run(request): Promise<AgentRun> {
      return {
        id: request.runId!,
        agentId: "test",
        sessionId: request.sessionId,
        status: "succeeded",
        input: request.input,
        steps: [],
        outcome: { kind: "silent" }
      };
    }
  };
  const runtime = new RuntimeCore({
    execution: store.execution,
    getWorkspace: (id) => store.getWorkspace(id),
    sessionWorkspace: (id) => store.sessionWorkspace(id),
    runs: store.runs,
    channels: new InMemoryChannelRegistry(),
    conversation: new ConversationRouter({
      groupTrigger: { mode: "mention", botUserIds: ["bot"] },
      privateTrigger: { mode: "always" }
    }),
    agent,
    tools,
    context: {
      graph: store.contextGraph,
      conversationStore: store,
      workspaceStore: store,
      transcriptStore: store,
      eventProcessStore: store
    }
  });
  const channel = new MockChannelAdapter();
  runtime.attachChannel(channel);
  onTestFinished(async () => {
    await runtime.dispose();
    store.close();
  });
  const task = () => store.execution.createTask(grant, { key: "goal", goal: "研究", acceptance: "形成结论" });
  return { store, runtime, channel, grant, tools, task, workspace: new RuntimeWorkspace(runtime, store) };
}

const event = (id: string, text: string, mention = false): SynapseChannelEvent => ({
  id,
  platform: "qq",
  channelId: "qq-local",
  eventType: "message.created",
  origin: "incoming",
  conversation: { id: "group", kind: "group" },
  sender: { id: "human" },
  message: {
    ...textMessage(text),
    segments: [...(mention ? [{ type: "mention" as const, userId: "bot" }] : []), { type: "text", text }]
  },
  receivedAt: new Date().toISOString()
});

describe("自主执行的领域边界与资源收敛", () => {
  it("本地变更与回执同事务提交，未提交事务重启后可以安全续作", async () => {
    const { store, grant, task } = await fixture();
    const goal = task();
    const intent = store.execution.advanceTask(grant, { id: goal.id, key: "local", instruction: "工作" });
    store.execution.claim(intent.id);
    store.runs.append(intent.runId, { key: "started", type: "run_started", status: "running" });
    store.runs.append(intent.runId, { key: "local-started", type: "tool_call_started", data: { callId: "local" } });
    store.execution.startOperation(intent.runId, "local", "task.create", { key: "child" }, "transactional");
    expect(() =>
      store.execution.transactionalTool("local", () => {
        store.execution.createTask(grant, { key: "child", goal: "子目标", acceptance: "完成" });
        throw new Error("crash before receipt");
      })
    ).toThrow(/crash/);
    expect(store.execution.listTasks(grant)).toHaveLength(1);
    store.recoverRuns();
    expect(store.runs.get(intent.runId)?.status).toBe("interrupted");
    expect(store.execution.pending()[0]?.id).toBe(intent.id);
    expect(store.execution.claim(intent.id)?.attempts).toBe(2);
    store.execution.startOperation(intent.runId, "local", "task.create", { key: "child" }, "transactional");
    store.execution.transactionalTool("local", () =>
      store.execution.createTask(grant, { key: "child", goal: "子目标", acceptance: "完成" })
    );
    expect(store.execution.operation("local")?.state).toBe("succeeded");
    expect(store.execution.listTasks(grant)).toHaveLength(2);
  });

  it("权威工具回执先于 Trace 投影提交时，只恢复投影并保留安全续作", async () => {
    const { store, grant, task } = await fixture();
    const intent = store.execution.advanceTask(grant, { id: task().id, key: "receipt", instruction: "工作" });
    store.execution.claim(intent.id);
    store.runs.append(intent.runId, { key: "started", type: "run_started", status: "running" });
    store.runs.append(intent.runId, {
      key: "effect-started",
      type: "tool_call_started",
      data: { callId: "confirmed" }
    });
    store.execution.startOperation(intent.runId, "confirmed", "external.write", {});
    store.execution.receipt("confirmed", "succeeded", { receipt: "confirmed-on-platform" });
    store.recoverRuns();
    expect(store.runs.get(intent.runId)?.status).toBe("interrupted");
    expect(store.execution.pending()[0]?.id).toBe(intent.id);
    expect(store.runs.latestEvent(intent.runId, "tool_call_succeeded")?.data).toMatchObject({
      output: { receipt: "confirmed-on-platform" }
    });
  });

  it("目标已完成而 Run 尚未结束时，原推进者恢复收尾且不重开目标", async () => {
    const { store, runtime, grant, task } = await fixture();
    const goal = task();
    const intent = store.execution.advanceTask(grant, { id: goal.id, key: "completed-task", instruction: "推进" });
    store.execution.claim(intent.id);
    store.runs.append(intent.runId, { key: "started", type: "run_started", status: "running" });
    store.execution.updateTask(grant, {
      id: goal.id,
      expectedRevision: 1,
      status: "completed",
      result: { runId: intent.runId, revision: 1, content: "已完成验收" }
    });
    store.recoverRuns();
    expect(store.runs.get(intent.runId)?.status).toBe("interrupted");
    runtime.start();
    await vi.waitFor(() => expect(store.runs.get(intent.runId)?.status).toBe("succeeded"));
    expect(store.execution.getTask(goal.id, grant)).toMatchObject({
      status: "completed",
      completedByRunId: intent.runId
    });
    expect(() => store.execution.advanceTask(grant, { id: goal.id, key: "new", instruction: "重开" })).toThrow(
      /not open/
    );
  });

  it("结果已保存而完成投影缺失时，重启不重新运行模型", async () => {
    const { store, grant, task } = await fixture();
    const intent = store.execution.advanceTask(grant, { id: task().id, key: "result", instruction: "工作" });
    store.execution.claim(intent.id);
    store.runs.append(intent.runId, { key: "started", type: "run_started", status: "running" });
    store.execution.saveResult(intent.runId, { kind: "silent" });
    store.recoverRuns();
    expect(store.runs.get(intent.runId)?.status).toBe("succeeded");
    expect(store.execution.pending()).toHaveLength(0);
  });

  it("Native 会话、工作区绑定与初始版本失败时整体回滚", async () => {
    const { store } = await fixture();
    const commit = store.contextGraph.commit.bind(store.contextGraph);
    const injection = vi.spyOn(store.contextGraph, "commit").mockImplementation((input) => {
      commit(input);
      throw new Error("root failure");
    });
    expect(() => store.createNativeSession({ id: "atomic-native", key: "atomic-native", title: "原子会话" })).toThrow(
      /root failure/
    );
    expect(await store.getSession("atomic-native")).toBeUndefined();
    expect(store.getWorkspace("personal:runtime-admin")).toBeUndefined();
    expect(store.contextGraph.getRef("atomic-native", "line:mainline:atomic-native")).toBeUndefined();
    injection.mockRestore();
    const session = store.createNativeSession({
      id: "atomic-native",
      key: "atomic-native",
      title: "原子会话",
      workspaceId: "project"
    });
    expect(session.workspaceId).toBe("project");
    await expect(store.bindSessionWorkspace(session.id, "other")).rejects.toThrow(/cannot change/);
  });
  it("关闭数据库并重新打开后，已接受工作保持同一 Run 并可安全领取", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-durable-intent-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath });
    try {
      await store.bindProjectWorkspace({ workspaceId: "project", identityId: "principal" });
      const grant = store.execution.issueGrant({
        key: "disk",
        workspaceId: "project",
        principalId: "principal",
        source: { platform: "qq", channelId: "test", conversationId: "group", conversationKind: "group" }
      });
      const task = store.execution.createTask(grant, { key: "disk", goal: "持久工作", acceptance: "完成" });
      const intent = store.execution.advanceTask(grant, { id: task.id, key: "disk", instruction: "推进" });
      expect(store.execution.advanceTask(grant, { id: task.id, key: "disk", instruction: "推进" }).id).toBe(intent.id);
      store.close();
      store = new SqliteRuntimeContextStore({ databasePath });
      store.recoverRuns();
      expect(store.execution.pending()[0]?.runId).toBe(intent.runId);
      expect(store.execution.claim(intent.id)?.attempts).toBe(1);
      expect(await store.getSession(`workspace:project`)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("执行额度不足时回滚输入接受，不留下半接受的规范消息", async () => {
    const { store } = await fixture({ maxRunsPerGrant: 1 });
    const grant = store.execution.issueGrant({
      key: "atomic",
      workspaceId: "project",
      principalId: "principal",
      sessionId: "atomic-session",
      source: { platform: "qq", channelId: "qq-local", conversationId: "group", conversationKind: "group" }
    });
    const accept = (key: string, project?: () => void) => {
      const incoming = event(key, "输入");
      return store.execution.acceptInput(
        {
          id: key,
          sessionId: "atomic-session",
          workspaceId: "project",
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          conversationType: "group",
          conversationId: "group",
          sourceEventId: key,
          sourceEventType: "message.created",
          senderId: "human",
          text: "输入",
          message: incoming.message!,
          receivedAt: incoming.receivedAt,
          idempotencyKey: key,
          lineEventType: "user_message"
        },
        (accepted) => ({
          key,
          grantId: grant.id,
          payload: {
            event: incoming,
            request: {
              sessionId: "atomic-session",
              workspaceId: "project",
              userId: "principal",
              input: incoming.message!,
              source: grant.source,
              event: incoming,
              contextPolicy: { includeHistory: false, maxMessages: 0 }
            },
            scope: { provider: "napcat", accepted }
          }
        }),
        project
      );
    };
    expect(() =>
      accept("first", () => {
        throw new Error("projection failed");
      })
    ).toThrow("projection failed");
    expect(await store.getNormalizedEvent("first")).toBeUndefined();
    expect(store.runs.list().items).toHaveLength(0);
    accept("first");
    expect(() => accept("second")).toThrow(/budget/);
    expect(await store.getNormalizedEvent("second")).toBeUndefined();
    expect(store.runs.list().items).toHaveLength(1);
  });
  it("未触发群消息只被短期观察，后续请求在本会话引用且当前输入唯一", async () => {
    const requests: Parameters<Agent["run"]>[0][] = [];
    const { runtime, store } = await fixture({
      agent: {
        id: "record",
        async run(request) {
          requests.push(request);
          return {
            id: request.runId!,
            agentId: "record",
            sessionId: request.sessionId,
            input: request.input,
            steps: [],
            status: "succeeded",
            outcome: { kind: "silent" }
          };
        }
      }
    });
    await runtime.handleChannelEvent(event("budget", "预算两万元"));
    expect(store.runs.list().items).toHaveLength(0);
    await runtime.handleChannelEvent(event("ask", "请按预算安排", true));
    expect(store.runs.list().items).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.promptContext)).toContain("预算两万元");
    expect(JSON.stringify(requests[0]?.promptContext)).not.toContain("请按预算安排");
    expect(store.execution.inspectTasks()).toEqual([]);
  });

  it("显式交互静默成功，不自动创建 Task 或运行分支和 Context Commit", async () => {
    const { runtime, store, channel } = await fixture();
    await runtime.handleChannelEvent(event("one", "请静默处理", true));
    const run = store.runs.list().items[0]!;
    expect(run.status).toBe("succeeded");
    expect(channel.sent).toHaveLength(0);
    expect(store.contextGraph.getRef(run.sessionId!, `run:one`)).toBeUndefined();
    expect(store.execution.result(run.id)).toEqual({ kind: "silent" });
  });

  it("同一 Task 单推进者，独立目标并行且过期 revision 产出仍保留", async () => {
    const { store, grant, task } = await fixture();
    const goal = task();
    const first = store.execution.advanceTask(grant, { id: goal.id, key: "a", instruction: "推进" });
    const second = store.execution.advanceTask(grant, { id: goal.id, key: "b", instruction: "继续" });
    expect(store.execution.claim(first.id)).toBeDefined();
    expect(store.execution.claim(second.id)).toBeUndefined();
    const other = store.execution.createTask(grant, { key: "other", goal: "另一个目标", acceptance: "完成" });
    expect(
      store.execution.claim(store.execution.advanceTask(grant, { id: other.id, key: "c", instruction: "推进" }).id)
    ).toBeDefined();
    store.execution.updateTask(grant, { id: goal.id, expectedRevision: 1, goal: "新目标" });
    const result = store.execution.updateTask(grant, {
      id: goal.id,
      expectedRevision: 1,
      status: "completed",
      result: { runId: first.runId, revision: 1, content: "旧结果" }
    });
    expect(result.conflict).toBe(true);
    expect(result.task.status).toBe("open");
    expect(result.task.results[0]?.content).toBe("旧结果");
    store.execution.finish(first.id);
    expect(store.execution.claim(second.id)?.taskRevision).toBe(2);
  });

  it("计划到期与 occurrence 去重原子推进，重启不重复接受", async () => {
    const { store, grant } = await fixture();
    const now = Date.now();
    const plan = store.execution.createSchedule(
      grant,
      {
        key: "periodic",
        rule: { kind: "interval", startAt: now + 1000, everyMs: 300_000 },
        instruction: "检查",
        mode: "agent",
        maxOccurrences: 2
      },
      now
    );
    expect(store.execution.tick(now + 1000)).toBe(1);
    store.recoverRuns();
    expect(store.execution.tick(now + 1000)).toBe(0);
    expect(store.execution.pending()).toHaveLength(1);
    expect(store.execution.schedule(plan.id)?.fired).toBe(1);
    expect(store.execution.schedule(plan.id)?.nextFireAt).toBe(now + 301_000);
  });

  it("一次性提醒不调用模型并保存通知回执", async () => {
    const run = vi.fn<Agent["run"]>();
    const { runtime, store, grant, channel } = await fixture({ agent: { id: "never", run } });
    const now = Date.now();
    store.execution.createSchedule(
      grant,
      { key: "remind", rule: { kind: "once", at: now + 1000 }, instruction: "喝水", mode: "reminder" },
      now
    );
    store.execution.tick(now + 1000);
    runtime.start();
    await vi.waitFor(() => expect(store.runs.list().items[0]?.status).toBe("succeeded"));
    expect(run).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message.segments).toEqual([{ type: "text", text: "喝水" }]);
    const intent = store.execution.forRun(store.runs.list().items[0]!.id)!;
    expect(store.execution.operation(`delivery:${intent.id}`)?.state).toBe("succeeded");
  });

  it("主动通知重新校验发送权限，禁止通知不会误记成功", async () => {
    const { runtime, store, grant, channel } = await fixture({ allowNotify: false });
    const now = Date.now();
    store.execution.createSchedule(
      grant,
      { key: "denied", rule: { kind: "once", at: now + 1000 }, instruction: "通知", mode: "reminder" },
      now
    );
    store.execution.tick(now + 1000);
    runtime.start();
    await vi.waitFor(() => expect(store.runs.list().items[0]?.status).toBe("blocked"));
    expect(channel.sent).toHaveLength(0);
  });

  it("确定发送失败只重试原结果交付，不重跑模型，重复重试请求不会再发送", async () => {
    const model = vi.fn<Agent["run"]>();
    const { runtime, store, grant, channel } = await fixture({ agent: { id: "unused", run: model } });
    channel.sendResults.push(
      { status: "failed", error: "platform rejected" },
      { status: "succeeded", messageId: "confirmed" }
    );
    const now = Date.now();
    store.execution.createSchedule(
      grant,
      { key: "delivery-retry", rule: { kind: "once", at: now + 1000 }, instruction: "可靠提醒", mode: "reminder" },
      now
    );
    store.execution.tick(now + 1000);
    const original = store.execution.pending()[0]!;
    runtime.start();
    await vi.waitFor(() => expect(store.runs.get(original.runId)?.status).toBe("failed"));
    const retry = store.execution.retryDelivery(original.runId, "retry");
    await vi.waitFor(() => expect(store.runs.get(retry.runId)?.status).toBe("succeeded"), { timeout: 3000 });
    expect(store.execution.retryDelivery(original.runId, "retry").id).toBe(retry.id);
    expect(channel.sent).toHaveLength(2);
    expect(model).not.toHaveBeenCalled();
    expect(store.runs.get(original.runId)?.status).toBe("failed");
    expect(store.execution.result(retry.runId)).toEqual(store.execution.result(original.runId));
  });

  it("发送结果未知时禁止重试和重启重放", async () => {
    const { runtime, store, grant, channel } = await fixture();
    channel.sendResults.push({ status: "uncertain", error: "receipt missing" });
    const now = Date.now();
    store.execution.createSchedule(
      grant,
      { key: "uncertain-delivery", rule: { kind: "once", at: now + 1000 }, instruction: "提醒", mode: "reminder" },
      now
    );
    store.execution.tick(now + 1000);
    const original = store.execution.pending()[0]!;
    runtime.start();
    await vi.waitFor(() => expect(store.runs.get(original.runId)?.status).toBe("uncertain"));
    expect(() => store.execution.retryDelivery(original.runId, "unsafe")).toThrow(/confirmed delivery failure/);
    store.recoverRuns();
    expect(store.execution.pending()).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
  });

  it.each(["cancel", "revoke", "task-terminal"])("%s 阻止排队的计划工作", async (action) => {
    const { store, grant, task } = await fixture();
    const goal = task();
    const now = Date.now();
    const schedule = store.execution.createSchedule(
      grant,
      { key: "stop", rule: { kind: "once", at: now + 1000 }, instruction: "工作", mode: "agent", taskId: goal.id },
      now
    );
    store.execution.tick(now + 1000);
    const intent = store.execution.pending()[0]!;
    if (action === "cancel") store.execution.updateSchedule(grant, schedule.id, 1, { status: "cancelled" });
    else if (action === "revoke") store.execution.revokeGrant(grant.id);
    else store.execution.updateTask(grant, { id: goal.id, expectedRevision: 1, status: "cancelled" });
    expect(store.execution.claim(intent.id)).toBeUndefined();
  });

  it("未知副作用恢复后保持阻断，已确认结果不会重新执行", async () => {
    const { store, grant, task } = await fixture();
    const intent = store.execution.advanceTask(grant, { id: task().id, key: "unknown", instruction: "执行" });
    store.execution.claim(intent.id);
    store.execution.startOperation(intent.runId, "operation", "external.send", { text: "消息" });
    store.recoverRuns();
    expect(store.execution.getIntent(intent.id)?.state).toBe("blocked");
    expect(store.execution.pending()).toHaveLength(0);
    expect(() => store.execution.startOperation(intent.runId, "operation", "external.send", { text: "消息" })).toThrow(
      /reconcile/
    );
  });

  it("无副作用的崩溃恢复保留 Run 身份，Attempt 上限跨重启生效", async () => {
    const { store, grant, task } = await fixture({ maxAttempts: 1 });
    const intent = store.execution.advanceTask(grant, { id: task().id, key: "recover", instruction: "工作" });
    store.execution.claim(intent.id);
    store.recoverRuns();
    expect(store.execution.pending()[0]?.runId).toBe(intent.runId);
    expect(store.execution.claim(intent.id)).toBeUndefined();
    expect(store.runs.get(intent.runId)?.status).toBe("blocked");
  });

  it("模型、工具和授权累计预算不会被创建后续工作或恢复重置", async () => {
    const { store, grant, task } = await fixture({ maxRunsPerGrant: 1, maxModelCallsPerRun: 1, maxToolCallsPerRun: 1 });
    const goal = task();
    const intent = store.execution.advanceTask(grant, { id: goal.id, key: "budget", instruction: "工作" });
    store.execution.consume(intent.runId, "model");
    store.execution.consume(intent.runId, "tool");
    store.recoverRuns();
    expect(() => store.execution.consume(intent.runId, "model")).toThrow(/budget/);
    expect(() => store.execution.consume(intent.runId, "tool")).toThrow(/budget/);
    expect(() => store.execution.advanceTask(grant, { id: goal.id, key: "another", instruction: "继续" })).toThrow(
      /budget/
    );
  });

  it("清理不刷新有效授权的累计额度，失效授权仍不能重新执行", async () => {
    const { store, runtime, grant, task } = await fixture({ maxRunsPerGrant: 1, retentionHours: 1 });
    const goal = task();
    const intent = store.execution.advanceTask(grant, { id: goal.id, key: "cleanup-budget", instruction: "推进" });
    runtime.start();
    await vi.waitFor(() => expect(store.execution.getIntent(intent.id)?.state).toBe("done"));
    const later = Date.now() + 2 * 3_600_000;
    expect(store.execution.collectionPreview(later).intents).toBe(0);
    store.execution.collect("delete-expired-derived-execution-records", later);
    expect(() => store.execution.advanceTask(grant, { id: goal.id, key: "extra", instruction: "继续" })).toThrow(
      /budget/
    );
    store.execution.revokeGrant(grant.id);
    expect(store.execution.collectionPreview(later).intents).toBe(1);
    store.execution.collect("delete-expired-derived-execution-records", later);
    expect(store.execution.getIntent(intent.id)).toBeUndefined();
    expect(() => store.execution.advanceTask(grant, { id: goal.id, key: "extra", instruction: "继续" })).toThrow(
      /revoked/
    );
    expect(store.runs.get(intent.runId)?.status).toBe("succeeded");
  });

  it("同工作区不同 Session 的历史版本与私有 Task 不会串读", async () => {
    const { store, grant, tools, task } = await fixture();
    const privateTask = task();
    const stranger = store.execution.issueGrant({
      key: "other",
      workspaceId: grant.workspaceId,
      principalId: "other",
      source: grant.source
    });
    expect(() => store.execution.getTask(privateTask.id, stranger)).toThrow(/unauthorized/);
    store.contextGraph.commit({
      scopeId: "secret-session",
      refName: "main",
      expectedVersion: null,
      idempotencyKey: "secret",
      type: "snapshot",
      content: { secret: "private" }
    });
    const commit = store.contextGraph.getRef("secret-session", "main")!;
    const intent = store.execution.advanceTask(grant, { id: privateTask.id, key: "read", instruction: "读取" });
    store.execution.claim(intent.id);
    await expect(
      tools.call(
        "context.read",
        { commitId: commit.commitId },
        { runId: intent.runId, sessionId: "", userId: grant.principalId, workspaceId: grant.workspaceId }
      )
    ).rejects.toThrow(/unauthorized/);
  });

  it("回显不唤醒，观察 TTL 与数量有界", async () => {
    const { store, runtime } = await fixture();
    await runtime.handleChannelEvent({ ...event("echo", "自己的消息", true), origin: "outgoing" });
    expect(store.runs.list().items).toHaveLength(0);
    for (let i = 0; i < 80; i++)
      store.execution.observe(
        { id: `o-${i}`, sessionId: "session", principalId: "p", contextEligible: true, event: event(`e-${i}`, "观察") },
        1000 + i
      );
    expect(store.execution.observations("session", 1100)).toHaveLength(64);
    expect(store.execution.observations("session", 1100 + 31 * 60_000)).toHaveLength(0);
  });

  it("执行中补充信息进入原 Run 的持久 Inbox", async () => {
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let adopted: readonly { id: number; content: string }[] = [];
    const { runtime, workspace, store } = await fixture({
      agent: {
        id: "steer",
        async run(request, context) {
          started();
          await wait;
          adopted = await context.checkpoint!();
          context.acknowledgeInputs!(adopted.at(-1)!.id);
          return {
            id: request.runId!,
            agentId: "steer",
            sessionId: request.sessionId,
            status: "succeeded",
            input: request.input,
            steps: [],
            outcome: { kind: "silent" }
          };
        }
      }
    });
    const session = await workspace.createSession({ title: "Inbox", idempotencyKey: "inbox" });
    const sessionId = (session.session as { id: string }).id;
    const first = await runtime.submitNative({ sessionId, text: "安排 A", idempotencyKey: "a" });
    await ready;
    const second = await runtime.submitNative({ sessionId, text: "改成 B", idempotencyKey: "b" });
    expect(second.id).toBe(first.id);
    release();
    await vi.waitFor(() => expect(store.runs.get(first.id)?.status).toBe("succeeded"));
    expect(adopted.map((item) => item.content)).toEqual(["改成 B"]);
  });

  it("完整区块共用全局预算，按来源去重并保留相同文本的不同事实", () => {
    const result = allocateContext(
      {
        messages: [
          { role: "user", content: "同样文本", sourceRef: "a", createdAt: "1" },
          { role: "user", content: "同样文本", sourceRef: "b", createdAt: "1" },
          { role: "user", content: "重复来源", sourceRef: "a", createdAt: "1" }
        ],
        metadata: {},
        sections: [
          {
            id: "required",
            blocks: [
              {
                id: "json",
                source: "trusted",
                stability: "turn",
                required: true,
                priority: 100,
                content: '{"valid":true}'
              }
            ]
          },
          {
            id: "large",
            blocks: [
              {
                id: "full",
                source: "optional",
                stability: "turn",
                required: false,
                priority: 1,
                content: JSON.stringify({ text: "x".repeat(1000) })
              }
            ]
          }
        ]
      },
      160
    );
    expect(result.manifest.usedChars).toBeLessThanOrEqual(160);
    expect(result.manifest.entries.filter((item) => item.reason === "duplicate")).toHaveLength(1);
    expect(result.context.messages).toHaveLength(2);
    expect(result.context.sections).toHaveLength(1);
    expect(JSON.parse(result.context.sections[0]!.blocks[0]!.content)).toEqual({ valid: true });
  });

  it("日历计划遵循时区和 DST，重复小时每天只触发一次", () => {
    const rule = { kind: "daily" as const, hour: 2, minute: 30, timezone: "America/New_York" };
    expect(new Date(nextScheduleTime(rule, Date.parse("2026-03-08T05:00:00Z"))!).toISOString()).toBe(
      "2026-03-09T06:30:00.000Z"
    );
    expect(new Date(nextScheduleTime({ ...rule, hour: 1 }, Date.parse("2026-11-01T05:30:00Z"))!).toISOString()).toBe(
      "2026-11-02T06:30:00.000Z"
    );
  });
});
