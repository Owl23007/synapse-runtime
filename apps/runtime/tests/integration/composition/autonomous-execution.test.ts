import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "../../../src/config/index.js";
import { createRuntimeAssembly, type RuntimeAssembly } from "../../../src/composition/runtime-assembly.js";
import type { RuntimeFetch } from "../../../src/types.js";

function create(fetch: RuntimeFetch): RuntimeAssembly {
  const directory = mkdtempSync(join(tmpdir(), "synapse-autonomy-"));
  const assembly = createRuntimeAssembly({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      autonomy: { pollIntervalMs: 100 },
      prompts: {
        enabled: true,
        catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
        defaultPurpose: "reasoning.chat_reply"
      },
      agent: {
        default: "model",
        providers: {
          model: { type: "openai-compatible", apiKey: "test-key", baseUrl: "https://model.invalid/v1", model: "model" }
        }
      },
      permissions: { "runtime.manage": "allow" }
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

const call = (name: string, input: unknown, id = name) =>
  Response.json({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }]
        },
        finish_reason: "tool_calls"
      }
    ]
  });

describe("生产模型的自主执行闭环", () => {
  it("模型创建目标、时间计划和显式版本，后续同一循环推进并通知，无额外回复 Agent", async () => {
    let calls = 0;
    let taskId = "";
    let scheduleId = "";
    const requests: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] = [];
    const assembly = create(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      calls++;
      const previous = body.messages.filter((message: { role: string }) => message.role === "tool").at(-1);
      if (calls === 1) {
        return call("task.create", { key: "research", goal: "研究项目", acceptance: "获得可靠结论" });
      }
      if (calls === 2) {
        taskId = JSON.parse(previous.content).output.id;
        return call("schedule.create", {
          key: "continue",
          rule: { kind: "once", at: Date.now() + 1000 },
          taskId,
          instruction: "完成研究",
          mode: "agent"
        });
      }
      if (calls === 3) {
        scheduleId = JSON.parse(previous.content).output.id;
        return call("context.commit", {
          key: "checkpoint",
          refName: "research",
          expectedVersion: null,
          content: { decision: "采用方案 A" }
        });
      }
      if (calls === 4) return call("runtime.finish", { kind: "waiting", scheduleId });
      if (calls === 5)
        return call("task.update", { id: taskId, expectedRevision: 1, status: "completed", result: "研究结论已确认" });
      if (calls === 6) return call("runtime.finish", { kind: "notify", text: "研究已完成" });
      throw new Error("Unexpected extra model request");
    });
    const created = await assembly.workspace.createSession({ title: "研究", idempotencyKey: "session" });
    const sessionId = (created.session as { id: string }).id;
    const first = await assembly.runtime.submitNative({
      sessionId,
      text: "持续推进研究，完成时通知",
      idempotencyKey: "request"
    });
    await expect.poll(() => assembly.contextStore.runs.get(first.id)?.status).toBe("succeeded");
    expect(calls).toBe(4);
    expect(requests[0]?.tools.map((tool) => tool.function.name)).toContain("runtime.finish");
    expect(assembly.contextStore.execution.result(first.id)).toEqual({ kind: "waiting", scheduleId });
    expect(assembly.contextStore.contextGraph.getRef(sessionId, "research")).toBeDefined();
    const grant = assembly.contextStore.execution.getGrant(assembly.contextStore.execution.forRun(first.id)!.grantId)!;
    assembly.contextStore.execution.tick(Date.now() + 2000);
    assembly.runtime.start();
    await expect.poll(() => assembly.contextStore.execution.getTask(taskId, grant).status).toBe("completed");
    await expect
      .poll(() => assembly.contextStore.runs.list().items.every((run) => run.status === "succeeded"))
      .toBe(true);
    expect(calls).toBe(6);
    expect(requests[4]?.messages.some((message) => message.content.includes("获得可靠结论"))).toBe(true);
    const workspace = await assembly.workspace.getWorkspace(sessionId);
    expect(JSON.stringify(workspace)).toContain("研究已完成");
  });

  it("HTTP 生成中收到更正，在副作用前重新交给模型且当前更正只注入一次", async () => {
    let assembly!: RuntimeAssembly;
    let sessionId = "";
    let calls = 0;
    const inputs: { content: string }[][] = [];
    assembly = create(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      inputs.push(body.messages);
      calls++;
      if (calls === 1) {
        await assembly.runtime.submitNative({ sessionId, text: "改成 B", idempotencyKey: "correction" });
        return call("context.commit", {
          key: "stale",
          refName: "stale",
          expectedVersion: null,
          content: { action: "A" }
        });
      }
      return call("runtime.finish", { kind: "silent" });
    });
    const created = await assembly.workspace.createSession({ title: "更正", idempotencyKey: "steering" });
    sessionId = (created.session as { id: string }).id;
    const run = await assembly.runtime.submitNative({ sessionId, text: "安排 A", idempotencyKey: "first" });
    await expect.poll(() => assembly.contextStore.runs.get(run.id)?.status).toBe("succeeded");
    expect(calls).toBe(2);
    expect(JSON.stringify(inputs[0])).not.toContain("改成 B");
    expect(inputs[1]?.filter((message) => message.content === "改成 B")).toHaveLength(1);
    expect(assembly.contextStore.contextGraph.getRef(sessionId, "stale")).toBeUndefined();
    expect(assembly.contextStore.runs.list().items).toHaveLength(1);
  });
});
