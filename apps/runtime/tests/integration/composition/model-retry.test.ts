import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "../../../src/config/index.js";
import { createRuntimeAssembly } from "../../../src/composition/runtime-assembly.js";
import type { RuntimeFetch } from "../../../src/types.js";

function create(fetch: RuntimeFetch, maxModelCallsPerRun = 8) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-model-retry-"));
  const assembly = createRuntimeAssembly({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      autonomy: {
        pollIntervalMs: 100,
        retryBaseDelayMs: 100,
        maxRetryDelayMs: 500,
        maxAttempts: 2,
        maxModelCallsPerRun
      },
      prompts: {
        enabled: true,
        catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
        defaultPurpose: "reasoning.chat_reply"
      },
      agent: {
        default: "model",
        providers: {
          model: { type: "openai-compatible", apiKey: "test-key", baseUrl: "https://model.invalid", model: "model" }
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

describe("模型暂时故障与安全 Attempt 重试", () => {
  it("首次 HTTP 503 沿用同一 Run 重试并只交付一次最终答复", async () => {
    let calls = 0;
    const assembly = create(async () => {
      calls++;
      return calls === 1
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ choices: [{ message: { content: "恢复后的答复" } }] });
    });
    const session = assembly.contextStore.createNativeSession({ id: "session", key: "session", title: "Retry" });
    assembly.runtime.start();
    const run = await assembly.runtime.submitNative({ sessionId: session.id, text: "执行", idempotencyKey: "input" });
    await vi.waitFor(() => expect(assembly.contextStore.runs.get(run.id)?.status).toBe("succeeded"), { timeout: 3000 });
    expect(calls).toBe(2);
    expect(assembly.contextStore.execution.forRun(run.id)?.attempts).toBe(2);
    expect(assembly.contextStore.runs.events(run.id).filter((event) => event.type === "run_interrupted")).toHaveLength(
      1
    );
    expect(
      (await assembly.contextStore.listEvents(session.mainlineId)).filter((event) => event.type === "assistant_message")
    ).toHaveLength(1);
  });

  it.each([
    { status: 401, calls: 1 },
    { status: 503, calls: 2 }
  ])("HTTP $status 按明确分类和尝试次数终结", async ({ status, calls: expected }) => {
    let calls = 0;
    const assembly = create(async () => {
      calls++;
      return Response.json({ error: "failure" }, { status });
    });
    assembly.contextStore.createNativeSession({ id: "session", key: "session", title: "Retry" });
    assembly.runtime.start();
    const run = await assembly.runtime.submitNative({ sessionId: "session", text: "执行", idempotencyKey: "input" });
    await vi.waitFor(() => expect(assembly.contextStore.runs.get(run.id)?.status).toBe("failed"), { timeout: 3000 });
    expect(calls).toBe(expected);
    expect(assembly.contextStore.execution.forRun(run.id)?.attempts).toBe(expected);
  });

  it("累计模型调用额度耗尽时不建立额外 Attempt", async () => {
    let calls = 0;
    const assembly = create(async () => {
      calls++;
      return Response.json({ error: "failure" }, { status: 503 });
    }, 1);
    assembly.contextStore.createNativeSession({ id: "session", key: "session", title: "Retry" });
    assembly.runtime.start();
    const run = await assembly.runtime.submitNative({ sessionId: "session", text: "执行", idempotencyKey: "input" });
    await vi.waitFor(() => expect(assembly.contextStore.runs.get(run.id)?.status).toBe("failed"));
    expect(calls).toBe(1);
    expect(assembly.contextStore.execution.forRun(run.id)?.attempts).toBe(1);
  });

  it("已发起外部动作后遇到模型暂时故障，不自动重试或重放未知动作", async () => {
    let calls = 0;
    let effects = 0;
    const assembly = create(async () => {
      calls++;
      return calls === 1
        ? Response.json({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    { id: "external", type: "function", function: { name: "test.external", arguments: "{}" } }
                  ]
                }
              }
            ]
          })
        : Response.json({ error: "unavailable" }, { status: 503 });
    });
    assembly.tools.register({
      name: "test.external",
      description: "外部动作",
      permission: { action: "runtime.manage", resource: "execution" },
      effect: "external",
      handle: async () => {
        effects++;
        throw new Error("transport outcome unknown");
      }
    });
    assembly.contextStore.createNativeSession({ id: "session", key: "session", title: "Retry" });
    assembly.runtime.start();
    const run = await assembly.runtime.submitNative({ sessionId: "session", text: "执行", idempotencyKey: "input" });
    await vi.waitFor(() => expect(assembly.contextStore.runs.get(run.id)?.status).toBe("uncertain"));
    expect(effects).toBe(1);
    expect(assembly.contextStore.execution.forRun(run.id)?.attempts).toBe(1);
    expect(assembly.contextStore.execution.forRun(run.id)?.state).toBe("blocked");
  });
});
