import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { RuntimeCore } from "../../../src/runtime/runtime-core.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function runtimeFor(store: SqliteRuntimeContextStore, agent: Agent) {
  return new RuntimeCore({
    execution: store.execution,
    getWorkspace: (id) => store.getWorkspace(id),
    sessionWorkspace: (id) => store.sessionWorkspace(id),
    runs: store.runs,
    channels: new InMemoryChannelRegistry(),
    conversation: new ConversationRouter({
      privateTrigger: { mode: "always" },
      groupTrigger: { mode: "mention", botUserIds: ["bot"] }
    }),
    agent,
    tools: new ToolRuntime(new StaticPermissionEngine({})),
    limits: { maxConcurrent: 2 },
    context: {
      graph: store.contextGraph,
      conversationStore: store,
      workspaceStore: store,
      transcriptStore: store,
      eventProcessStore: store
    }
  });
}

const silent = async (request: AgentRequest): Promise<AgentRun> => ({
  id: request.runId!,
  agentId: "test",
  sessionId: request.sessionId,
  input: request.input,
  status: "succeeded",
  steps: [],
  outcome: { kind: "silent" }
});

describe("执行审计的持久一致性与公平调度", () => {
  it("频道补充消息和主输入均持久归档，重投不会创建额外 Run", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    const started = gate();
    const release = gate();
    const runtime = runtimeFor(store, {
      id: "test",
      run: async (request) => {
        started.release();
        await release.promise;
        return silent(request);
      }
    });
    onTestFinished(async () => {
      release.release();
      await runtime.dispose();
      store.close();
    });
    const event = (id: string, text: string): SynapseChannelEvent => ({
      id,
      platform: "qq",
      channelId: "channel",
      eventType: "message.created",
      origin: "incoming",
      conversation: { id: "user", kind: "private" },
      sender: { id: "human" },
      message: textMessage(text),
      receivedAt: new Date().toISOString()
    });
    const a = event("a", "A");
    const b = event("b", "B");
    const first = runtime.handleChannelEvent(a, "napcat");
    await started.promise;
    await runtime.handleChannelEvent(b, "napcat");
    await runtime.handleChannelEvent(b, "napcat");
    release.release();
    await first;
    await runtime.handleChannelEvent(b, "napcat");
    const sessionId = "qq:napcat:channel:private:user";
    expect((await store.listNormalizedEvents(sessionId)).map((item) => item.text)).toEqual(["A", "B"]);
    expect((await store.listRecent(sessionId, { limit: 20 })).map((item) => item.text)).toEqual(["A", "B"]);
    expect(store.runs.list().items).toHaveLength(1);
  });

  it("Native 补充输入进入会话历史，重启重投不唤醒，新 Run 可读取", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-inbox-history-"));
    const databasePath = join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeContextStore({ databasePath });
    const started = gate();
    const release = gate();
    let runtime = runtimeFor(store, {
      id: "test",
      run: async (request, context) => {
        started.release();
        await release.promise;
        expect((await context.checkpoint!()).map((item) => item.content)).toEqual(["修订 B"]);
        return silent(request);
      }
    });
    onTestFinished(async () => {
      release.release();
      await runtime.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.createNativeSession({ id: "session", key: "session", title: "Inbox" });
    const first = await runtime.submitNative({ sessionId: "session", text: "原始 A", idempotencyKey: "a" });
    await started.promise;
    const supplement = { sessionId: "session", text: "修订 B", idempotencyKey: "b" };
    expect((await runtime.submitNative(supplement)).id).toBe(first.id);
    expect((await runtime.submitNative(supplement)).id).toBe(first.id);
    expect(
      (await store.listRecent("session", { limit: 20 })).filter((message) => message.text === "修订 B")
    ).toHaveLength(1);
    release.release();
    await vi.waitFor(() => expect(store.runs.get(first.id)?.status).toBe("succeeded"));
    await runtime.dispose();
    store.close();
    store = new SqliteRuntimeContextStore({ databasePath });
    store.recoverRuns();
    const requests: AgentRequest[] = [];
    runtime = runtimeFor(store, {
      id: "test",
      run: async (request) => {
        requests.push(request);
        return silent(request);
      }
    });
    expect((await runtime.submitNative(supplement)).id).toBe(first.id);
    expect(requests).toHaveLength(0);
    const next = await runtime.submitNative({ sessionId: "session", text: "继续 C", idempotencyKey: "c" });
    await vi.waitFor(() => expect(store.runs.get(next.id)?.status).toBe("succeeded"));
    expect(next.id).not.toBe(first.id);
    expect(requests[0]?.promptContext?.messages.filter((message) => message.content.includes("修订 B"))).toHaveLength(
      1
    );
    expect((await store.listNormalizedEvents("session")).filter((event) => event.text === "修订 B")).toHaveLength(1);
    store.execution.collect("delete-expired-derived-execution-records", Date.now() + 8 * 86_400_000);
    expect(store.execution.forRun(first.id)).toBeUndefined();
    expect((await runtime.submitNative(supplement)).id).toBe(first.id);
    expect(requests).toHaveLength(1);
  });

  it("附件投影失败回滚规范补充消息和 Inbox", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    const started = gate();
    const release = gate();
    const runtime = runtimeFor(store, {
      id: "test",
      run: async (request) => {
        started.release();
        await release.promise;
        return silent(request);
      }
    });
    onTestFinished(async () => {
      release.release();
      await runtime.dispose();
      store.close();
    });
    store.createNativeSession({ id: "session", key: "session", title: "Inbox" });
    const run = await runtime.submitNative({ sessionId: "session", text: "A", idempotencyKey: "a" });
    await started.promise;
    const input = {
      id: "supplement",
      sessionId: "session",
      workspaceId: store.sessionWorkspace("session")!,
      targetLineId: "mainline:session",
      platform: "native",
      provider: "native",
      channelId: "native",
      conversationType: "private",
      conversationId: "session",
      sourceEventId: "supplement",
      sourceEventType: "message.created",
      senderId: "runtime-admin",
      text: "B",
      receivedAt: new Date().toISOString(),
      idempotencyKey: "supplement"
    };
    expect(() =>
      store.execution.acceptSupplement(run.id, input, () => {
        throw new Error("attachment projection failed");
      })
    ).toThrow(/projection failed/);
    expect(await store.getNormalizedEvent("supplement")).toBeUndefined();
    expect(store.execution.inputs(run.id, true)).toEqual([]);
    store.execution.acceptSupplement(run.id, input);
    expect(store.execution.inputs(run.id, true)).toHaveLength(1);
  });

  it("容量不足的首次输入不遗留授权或规范消息", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:", autonomy: { maxPendingIntents: 1 } });
    const started = gate();
    const release = gate();
    const runtime = runtimeFor(store, {
      id: "test",
      run: async (request) => {
        started.release();
        await release.promise;
        return silent(request);
      }
    });
    onTestFinished(async () => {
      release.release();
      await runtime.dispose();
      store.close();
    });
    store.createNativeSession({ id: "one", key: "one", title: "One" });
    store.createNativeSession({ id: "two", key: "two", title: "Two" });
    await runtime.submitNative({ sessionId: "one", text: "A", idempotencyKey: "a" });
    await started.promise;
    const issue = vi.spyOn(store.execution, "issueGrant");
    await expect(runtime.submitNative({ sessionId: "two", text: "B", idempotencyKey: "b" })).rejects.toThrow(
      /capacity/
    );
    const grant = issue.mock.results[0]!.value as { id: string };
    expect(store.execution.getGrant(grant.id)).toBeUndefined();
    expect(await store.getNormalizedEvent("native:two:b")).toBeUndefined();
  });

  it("同一目标前方超过 32 个排队请求时，独立目标仍能执行", async () => {
    const store = new SqliteRuntimeContextStore({
      databasePath: ":memory:",
      autonomy: { maxRunsPerGrant: 100, maxRunsPerHour: 100, pollIntervalMs: 100 }
    });
    await store.bindProjectWorkspace({ workspaceId: "project", identityId: "owner" });
    const grant = store.execution.issueGrant({
      key: "grant",
      workspaceId: "project",
      principalId: "owner",
      source: { platform: "native", channelId: "native", conversationId: "project", conversationKind: "system" }
    });
    const a = store.execution.createTask(grant, { key: "a", goal: "A", acceptance: "完成" });
    const b = store.execution.createTask(grant, { key: "b", goal: "B", acceptance: "完成" });
    const started = gate();
    const release = gate();
    const runtime = runtimeFor(store, {
      id: "test",
      run: async (request) => {
        if (request.taskId === a.id) {
          started.release();
          await release.promise;
        }
        return silent(request);
      }
    });
    onTestFinished(async () => {
      release.release();
      await runtime.dispose();
      store.close();
    });
    const first = store.execution.advanceTask(grant, { id: a.id, key: "first", instruction: "A" });
    runtime.start();
    await started.promise;
    for (let i = 0; i < 40; i++) store.execution.advanceTask(grant, { id: a.id, key: `queued-${i}`, instruction: "A" });
    const independent = store.execution.advanceTask(grant, { id: b.id, key: "independent", instruction: "B" });
    await vi.waitFor(() => expect(store.runs.get(independent.runId)?.status).toBe("succeeded"));
    expect(store.runs.get(first.runId)?.status).toBe("running");
  });
});
