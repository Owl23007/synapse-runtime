import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "../../../src/config/index.js";
import { createRuntimeAssembly, type RuntimeAssembly } from "../../../src/composition/runtime-assembly.js";
import type { RuntimeFetch } from "../../../src/types.js";
import type { ToolVisibilityAudit } from "../../../src/composition/tool-visibility.js";

interface ModelRequest {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string; description: string } }[];
}

function fixture(fetch: RuntimeFetch, permissions?: Record<string, "allow" | "deny">, history = true) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-context-capabilities-"));
  const assembly = createRuntimeAssembly({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      context: { enabled: history },
      prompts: {
        enabled: true,
        catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
        defaultPurpose: "reasoning.chat_reply"
      },
      agent: {
        default: "model",
        providers: {
          model: {
            type: "openai-compatible",
            apiKey: "test",
            baseUrl: "https://model.invalid/v1",
            model: "model"
          }
        }
      },
      ...(permissions === undefined ? {} : { permissions })
    }),
    channels: new InMemoryChannelRegistry(),
    logger: { info() {}, warn() {}, error() {} },
    fetch
  });
  onTestFinished(async () => {
    await assembly.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return assembly;
}

const call = (name: string, input: unknown) =>
  Response.json({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(input) } }]
        },
        finish_reason: "tool_calls"
      }
    ]
  });
const reply = () => Response.json({ choices: [{ message: { content: "收到" }, finish_reason: "stop" }] });
async function session(assembly: RuntimeAssembly, key: string) {
  return (await assembly.workspace.createSession({ title: key, idempotencyKey: key })).session as { id: string };
}
async function submit(assembly: RuntimeAssembly, sessionId: string, text: string, key: string, lineId?: string) {
  const run = await assembly.runtime.submitNative({
    sessionId,
    text,
    idempotencyKey: key,
    ...(lineId ? { lineId } : {})
  });
  await expect.poll(() => assembly.contextStore.runs.get(run.id)?.status).toBe("succeeded");
  return run;
}

describe("Native 能力与上下文一致性", () => {
  it("分支按自己的最新显式快照继续，不混入主线当前头", async () => {
    const requests: ModelRequest[] = [];
    const assembly = fixture(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return call("runtime.finish", { kind: "silent" });
    });
    const created = await session(assembly, "branch");
    const mainlineId = (await assembly.contextStore.getSession(created.id))!.mainlineId;
    const graph = assembly.contextStore.contextGraph;
    const base = graph.commit({
      scopeId: created.id,
      refName: "research",
      expectedVersion: null,
      idempotencyKey: "base",
      type: "snapshot",
      content: { decision: "分支旧状态" }
    });
    const { branch } = await assembly.workspace.fork(created.id, {
      commitId: base.id,
      title: "设计分支",
      idempotencyKey: "fork"
    });
    const mainline = graph.getRef(created.id, `line:${mainlineId}`)!;
    graph.commit({
      scopeId: created.id,
      refName: mainline.name,
      expectedVersion: mainline.version,
      idempotencyKey: "mainline-new",
      type: "snapshot",
      content: { decision: "主线新状态" }
    });
    await submit(assembly, created.id, "继续设计", "branch-first", branch.id);
    expect(JSON.stringify(requests[0])).toContain("分支旧状态");
    expect(JSON.stringify(requests[0])).not.toContain("主线新状态");
    const snapshot = requests[0]!.messages.find((message) => message.content.includes("分支旧状态"))!;
    expect({ role: snapshot.role, source: JSON.parse(snapshot.content).source }).toMatchInlineSnapshot(`
      {
        "role": "user",
        "source": "conversation-store",
      }
    `);
    graph.commit({
      scopeId: created.id,
      refName: `line:${branch.id}`,
      expectedVersion: 1,
      idempotencyKey: "branch-next",
      type: "snapshot",
      content: { decision: "分支后续状态" }
    });
    await submit(assembly, created.id, "继续", "branch-second", branch.id);
    expect(JSON.stringify(requests[1])).toContain("分支后续状态");
    expect(JSON.stringify(requests[1])).not.toContain("主线新状态");
  });

  it("已领取运行不能通过其他会话、工作区或主体发现任务能力", async () => {
    let assembly!: RuntimeAssembly;
    let sessionId = "";
    assembly = fixture(async () => {
      const active = assembly.contextStore.execution.activeForSession(sessionId, "runtime-admin")!;
      const scope = { runId: active.runId, sessionId, workspaceId: "personal:runtime-admin", userId: "runtime-admin" };
      expect(assembly.tools.inspectForContext(scope).find(({ tool }) => tool.name === "task.create")!.available).toBe(
        true
      );
      for (const patch of [{ sessionId: "other" }, { workspaceId: "other" }, { userId: "other" }]) {
        expect(
          assembly.tools.inspectForContext({ ...scope, ...patch }).find(({ tool }) => tool.name === "task.create")
        ).toMatchObject({ available: false, reason: "execution_scope_mismatch" });
      }
      return call("runtime.finish", { kind: "silent" });
    });
    sessionId = (await session(assembly, "scope")).id;
    await submit(assembly, sessionId, "检查任务", "scope-check");
  });

  it("默认权限暴露任务工具并持久创建目标，长期目标不会隐式产生定时计划", async () => {
    const requests: ModelRequest[] = [];
    const assembly = fixture(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? call("task.create", { key: "design", goal: "设计 Runtime", acceptance: "用户确认方案" })
        : call("runtime.finish", { kind: "silent" });
    });
    const created = await session(assembly, "native");
    const run = await submit(assembly, created.id, "创建长期的 Runtime 设计任务", "create");
    const audit = assembly.contextStore.runs.latestEvent(run.id, "tool_visibility_resolved")!
      .data as ToolVisibilityAudit;
    expect(audit).toMatchObject({
      registeredTools: expect.arrayContaining(["task.create", "asset.read"]),
      availableTools: expect.arrayContaining(["task.create"]),
      allowedTools: expect.arrayContaining(["task.create"]),
      exposedTools: expect.arrayContaining(["task.create"])
    });
    expect(requests[0]!.tools!.map((tool) => tool.function.name)).toContain("task.create");
    const system = requests[0]!.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    expect(system).toContain("Synapse Native 会话");
    expect(system).toContain("长期任务不等于定时任务");
    expect(system).not.toContain("生成成功与交付成功");
    expect(JSON.stringify(requests[0])).not.toContain("registeredTools");
    const intent = assembly.contextStore.execution.forRun(run.id)!;
    const grant = assembly.contextStore.execution.getGrant(intent.grantId)!;
    expect(assembly.contextStore.execution.listTasks(grant)).toMatchObject([
      { goal: "设计 Runtime", sessionId: created.id }
    ]);
    expect(assembly.contextStore.execution.listSchedules(grant)).toEqual([]);
  });

  it("显式权限表不自动扩权，拒绝原因只写审计且不注入工具相关策略或缓存文件", async () => {
    let request!: ModelRequest;
    const assembly = fixture(async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return reply();
    }, {});
    const created = await session(assembly, "denied");
    assembly.contextStore.assets.observe({
      workspaceId: "personal:runtime-admin",
      name: "旧截图.png",
      kind: "native",
      locator: { uploadId: "old" }
    });
    const run = await submit(assembly, created.id, "创建长期任务", "denied-request");
    expect(request.tools).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("旧截图.png");
    expect(JSON.stringify(request)).not.toContain("长期任务不等于定时任务");
    expect(JSON.stringify(request)).not.toContain("asset.read");
    const audit = assembly.contextStore.runs.latestEvent(run.id, "tool_visibility_resolved")!
      .data as ToolVisibilityAudit;
    expect(audit.rejected).toContainEqual(expect.objectContaining({ name: "task.create", stage: "permission" }));
    expect(audit.rejected).toContainEqual(expect.objectContaining({ name: "asset.read", stage: "permission" }));
    const task = assembly.tools
      .inspectForContext({
        runId: "missing",
        sessionId: created.id,
        userId: "runtime-admin",
        workspaceId: "personal:runtime-admin"
      })
      .find((item) => item.tool.name === "task.create");
    expect(task).toMatchObject({ available: false, reason: "execution_intent_missing" });
  });

  it("关闭聊天历史后仍恢复任务与 Context Head，并隔离另一会话的同名幂等键", async () => {
    let count = 0;
    const requests: ModelRequest[] = [];
    const assembly = fixture(
      async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        count++;
        if (count === 1) return call("task.create", { key: "design", goal: "持久目标甲", acceptance: "确认架构" });
        if (count === 2)
          return call("context.commit", {
            key: "snapshot",
            refName: "research",
            expectedVersion: null,
            content: { decision: "保留结构化状态" }
          });
        if (count === 5) return call("task.create", { key: "design", goal: "持久目标乙", acceptance: "确认方案乙" });
        return call("runtime.finish", { kind: "silent" });
      },
      undefined,
      false
    );
    const first = await session(assembly, "first");
    await submit(assembly, first.id, "创建长期目标", "first-create");
    await submit(assembly, first.id, "继续昨天的研究", "continue");
    const continuation = requests[3]!;
    const state = continuation.messages.find((message) => message.content.includes("保留结构化状态"))!;
    expect(state.role).toBe("user");
    expect(state.content).toContain("持久目标甲");
    expect(state.content).toContain("contextRefs");
    const second = await session(assembly, "second");
    await submit(assembly, second.id, "创建另一个目标", "second-create");
    expect(JSON.stringify(requests[4])).not.toContain("持久目标甲");
    expect(JSON.stringify(requests[4])).not.toContain("保留结构化状态");
    const tasks = assembly.contextStore.execution.inspectTasks();
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
  });

  it("文件候选只在有关联且读取获准时出现，资源名称以外部数据呈现", async () => {
    const requests: ModelRequest[] = [];
    const assembly = fixture(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return reply();
    });
    const created = await session(assembly, "files");
    const asset = assembly.contextStore.assets.observe({
      workspaceId: "personal:runtime-admin",
      name: "报告.txt",
      kind: "native",
      locator: { uploadId: "report" }
    });
    await submit(assembly, created.id, "创建长期任务", "unrelated");
    expect(JSON.stringify(requests[0])).not.toContain(asset.id);
    await submit(assembly, created.id, "读取报告.txt", "read");
    const reference = requests[1]!.messages.find((message) => message.content.includes(asset.id))!;
    expect(reference.role).toBe("user");
    expect(reference.content).toContain("resource-index");
    expect(requests[1]!.tools!.map((tool) => tool.function.name)).toContain("asset.read");
  });
});
