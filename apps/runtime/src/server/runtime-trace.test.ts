import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import { createRuntimeFromConfig, type RuntimeFactoryResult } from "./runtime-factory.js";
import { parseConfigObject } from "../config/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const event: SynapseChannelEvent = {
  id: "message-1",
  platform: "qq",
  channelId: "qq",
  eventType: "message.created",
  conversation: { id: "123", kind: "group" },
  sender: { id: "456" },
  message: textMessage("生成表格"),
  receivedAt: new Date().toISOString()
};

function setup(
  options: {
    modelFail?: boolean;
    sendFail?: boolean;
    uploadStatus?: "succeeded" | "failed" | "uncertain";
    sendAllowed?: boolean;
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-run-integration-"));
  const channels = new InMemoryChannelRegistry();
  let modelCalls = 0;
  let sends = 0;
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    conversation: { groupTrigger: { mode: "always" } },
    agent: {
      default: "model",
      providers: {
        model: {
          type: "openai-compatible",
          apiKey: "trace-canary-secret",
          baseUrl: "https://model.invalid/v1",
          model: "trace-model"
        }
      }
    },
    prompts: {
      enabled: true,
      catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
      defaultPurpose: "reasoning.chat_reply"
    },
    permissions: {
      "channel.qq.send_group_message": options.sendAllowed === false ? "deny" : "allow",
      "channel.qq.upload_group_file": "allow"
    }
  });
  const create = (): RuntimeFactoryResult =>
    createRuntimeFromConfig({
      config,
      channels,
      logger: { info() {}, warn() {}, error() {} },
      fetch: async () => {
        modelCalls++;
        if (options.modelFail) throw new Error("model failure trace-canary-secret");
        if (options.uploadStatus && modelCalls === 1)
          return Response.json({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "upload-1",
                      type: "function",
                      function: { name: "artifact.upload", arguments: '{"artifactId":"artifact-1"}' }
                    }
                  ]
                }
              }
            ]
          });
        return Response.json({ choices: [{ message: { content: "处理完成 trace-canary-secret" } }] });
      }
    });
  let result = create();
  if (options.uploadStatus)
    result.tools.register({
      name: "artifact.upload",
      description: "Upload",
      permission: { action: "channel.qq.upload_group_file", resource: "group-file" },
      async handle() {
        return { status: options.uploadStatus, artifactId: "artifact-1" };
      }
    });
  const attach = () =>
    result.runtime.attachChannel(
      new OneBot11ChannelAdapter({
        id: "qq",
        transport: "http",
        endpoint: "http://napcat.invalid",
        fetch: async () => {
          sends++;
          if (options.sendFail) throw new Error("send outcome unknown");
          return Response.json({ status: "ok", retcode: 0, data: { message_id: "reply-1" } });
        }
      })
    );
  attach();
  cleanup.push(async () => {
    await result.runtime.dispose();
    result.contextStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get result() {
      return result;
    },
    get counts() {
      return { modelCalls, sends };
    },
    async restart() {
      await result.runtime.dispose();
      result.contextStore.close();
      channels.unregister("qq");
      result = create();
      attach();
    }
  };
}

describe("生产运行追踪", () => {
  it("模型与回复形成持久事件链，重启和重复事件复用运行身份", async () => {
    const fixture = setup();
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    const run = fixture.result.contextStore.runs.list().items[0]!;
    expect(run.status).toBe("succeeded");
    const events = fixture.result.contextStore.runs.events(run.id);
    expect(events.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        "run_accepted",
        "run_started",
        "context_resolved",
        "model_call_started",
        "model_call_succeeded",
        "permission_allowed",
        "response_sending",
        "response_sent",
        "run_succeeded"
      ])
    );
    expect(events.map((item) => item.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.find((item) => item.type === "model_call_started")?.data).toMatchObject({
      model: "trace-model",
      messages: expect.any(Array)
    });
    expect(events.find((item) => item.type === "model_call_succeeded")?.data).toMatchObject({ usage: null });
    expect(JSON.stringify(events)).not.toContain("trace-canary-secret");
    await fixture.restart();
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    expect(fixture.result.contextStore.runs.list().items).toEqual([run]);
    expect(fixture.counts).toEqual({ modelCalls: 1, sends: 1 });
  });

  it("模型失败后的通知不把任务标记为成功", async () => {
    const fixture = setup({ modelFail: true });
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    const run = fixture.result.contextStore.runs.list().items[0]!;
    expect(run.status).toBe("failed");
    expect(run.error?.message).not.toContain("trace-canary-secret");
    expect(fixture.result.contextStore.runs.events(run.id).map((item) => item.type)).toContain("response_sent");
  });

  it.each(["failed", "uncertain"] as const)("上传返回 %s 时不能被模型成功回复掩盖", async (uploadStatus) => {
    const fixture = setup({ uploadStatus });
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    const run = fixture.result.contextStore.runs.list().items[0]!;
    expect(run.status).toBe(uploadStatus);
    expect(fixture.result.contextStore.runs.events(run.id).map((item) => item.type)).toContain(
      `artifact_upload_${uploadStatus}`
    );
    expect(fixture.counts.sends).toBe(1);
  });

  it("发送权限拒绝保留阻断终态，未执行频道动作", async () => {
    const fixture = setup({ sendAllowed: false });
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    expect(fixture.result.contextStore.runs.list().items[0]?.status).toBe("blocked");
    expect(fixture.counts.sends).toBe(0);
  });

  it("频道抛出异常时保留未知结果，重复消息不重新执行或发送", async () => {
    const fixture = setup({ sendFail: true });
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    const run = fixture.result.contextStore.runs.list().items[0]!;
    expect(run.status).toBe("uncertain");
    await fixture.restart();
    await fixture.result.runtime.handleChannelEvent(event, "napcat");
    expect(fixture.counts).toEqual({ modelCalls: 1, sends: 1 });
  });
});
