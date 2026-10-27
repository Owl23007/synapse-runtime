import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { createRuntimeFromConfig } from "./runtime-factory.js";
import { parseConfigObject } from "../config/index.js";
import type { RuntimeFetch } from "../types.js";

function fixture(fetch: RuntimeFetch, limits: Record<string, number> = {}, maxInputChars = 64_000) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-limits-"));
  const config = parseConfigObject({
    runtime: { dataDir: directory, limits },
    conversation: { groupTrigger: { mode: "always" } },
    agent: {
      default: "model",
      providers: {
        model: {
          type: "openai-compatible",
          apiKey: "test-secret",
          baseUrl: "https://model.invalid",
          model: "test-model",
          timeoutMs: 300_000
        }
      }
    },
    agentLoop: { maxInputChars },
    prompts: {
      enabled: true,
      catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
      defaultPurpose: "reasoning.chat_reply"
    },
    permissions: { "channel.qq.send_group_message": "allow", "test.slow": "allow" }
  });
  const result = createRuntimeFromConfig({
    config,
    fetch,
    channels: new InMemoryChannelRegistry(),
    logger: { info() {}, warn() {}, error() {} }
  });
  let sends = 0;
  result.runtime.attachChannel(
    new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://napcat.invalid",
      fetch: async () => {
        sends++;
        return Response.json({ status: "ok", retcode: 0, data: { message_id: "reply" } });
      }
    })
  );
  const event: SynapseChannelEvent = {
    id: "limits-event",
    platform: "qq",
    channelId: "qq",
    eventType: "message.created",
    conversation: { id: "group", kind: "group" },
    sender: { id: "user" },
    message: textMessage("生成报告"),
    receivedAt: new Date().toISOString()
  };
  return {
    ...result,
    event,
    get sends() {
      return sends;
    },
    async close() {
      await result.runtime.dispose();
      result.contextStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

describe("生产执行约束", () => {
  it("运行截止停止模型与迟到交付，容量已满的请求没有被接受", async () => {
    let started = () => {};
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = (_value: Response) => {};
    let signal: AbortSignal | undefined;
    const runtime = fixture(
      async (_url, init) => {
        signal = init?.signal;
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
      { maxConcurrent: 1, maxQueued: 0, runTimeoutMs: 150 }
    );
    try {
      const first = runtime.runtime.handleChannelEvent(runtime.event, "napcat");
      await modelStarted;
      await expect(runtime.runtime.handleChannelEvent({ ...runtime.event, id: "other" }, "napcat")).rejects.toThrow(
        "队列已满"
      );
      await first;
      expect(signal?.aborted).toBe(true);
      expect(runtime.contextStore.runs.list().items).toHaveLength(1);
      expect(runtime.contextStore.runs.list().items[0]?.status).toBe("failed");
      finish(Response.json({ choices: [{ message: { content: "late" } }] }));
      await Promise.resolve();
      expect(runtime.sends).toBe(0);
    } finally {
      await runtime.close();
    }
  });
  it("工具超时将真实运行标为未知，即使模型随后返回文本也不能掩盖", async () => {
    let models = 0;
    let tools = 0;
    const runtime = fixture(
      async () =>
        Response.json({
          choices: [
            {
              message:
                ++models === 1
                  ? {
                      content: "",
                      tool_calls: [{ id: "slow-1", type: "function", function: { name: "slow", arguments: "{}" } }]
                    }
                  : { content: "done" }
            }
          ]
        }),
      { toolTimeoutMs: 100 }
    );
    runtime.tools.register({
      name: "slow",
      description: "Slow external action",
      permission: { action: "test.slow", resource: "test" },
      handle: async (_input, context) => {
        tools++;
        return new Promise((resolve) =>
          context.signal!.addEventListener("abort", () => resolve("cleanup"), { once: true })
        );
      }
    });
    try {
      await runtime.runtime.handleChannelEvent(runtime.event, "napcat");
      const run = runtime.contextStore.runs.list().items[0]!;
      expect(run.status).toBe("uncertain");
      expect(run.error?.code).toBe("tool_outcome_uncertain");
      await runtime.runtime.handleChannelEvent(runtime.event, "napcat");
      expect(tools).toBe(1);
    } finally {
      await runtime.close();
    }
  });
  it("退出宽限到期取消正在等待的模型，不等待原请求超时", async () => {
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = fixture(
      async () => {
        started();
        return new Promise(() => {});
      },
      { shutdownGraceMs: 100, runTimeoutMs: 300_000 }
    );
    try {
      const active = runtime.runtime.handleChannelEvent(runtime.event, "napcat");
      await ready;
      const start = Date.now();
      await runtime.runtime.dispose();
      await active;
      expect(Date.now() - start).toBeLessThan(1500);
      expect(runtime.sends).toBe(0);
      expect(runtime.contextStore.runs.list().items[0]?.status).toBe("failed");
    } finally {
      await runtime.close();
    }
  });
  it("模型最终输入超预算时不访问 Provider，并保留可检查错误", async () => {
    let calls = 0;
    const runtime = fixture(
      async () => {
        calls++;
        throw new Error("must not call");
      },
      {},
      1024
    );
    try {
      await runtime.runtime.handleChannelEvent({ ...runtime.event, message: textMessage("x".repeat(2000)) }, "napcat");
      expect(calls).toBe(0);
      const run = runtime.contextStore.runs.list().items[0]!;
      expect(run.status).toBe("failed");
      expect(JSON.stringify(runtime.contextStore.runs.events(run.id))).toContain("字符预算");
    } finally {
      await runtime.close();
    }
  });
});
