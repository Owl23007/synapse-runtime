import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { textMessage, type SynapseChannelEvent } from "@synapse/runtime-protocol";
import type { DockerCommandRunner } from "@synapse/runtime-tool-container";
import { createRuntimeFromConfig } from "./runtime-factory.js";
import { parseConfigObject, loadConfigFile } from "../config/index.js";
import { ArtifactDeliveryStore } from "../composition/artifact-delivery.js";

const logger = { info() {}, warn() {}, error() {} };
const script = "from pathlib import Path\nPath('report.csv').write_text('name,value\\n测试,42\\n',encoding='utf-8')";

describe("group DAG container artifact loop", () => {
  it("绑定当前群与工件会话，拒绝跨群读取、私聊和模型伪造的上传目标", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-artifact-scope-"));
    const channels = new InMemoryChannelRegistry();
    let uploads = 0;
    const runtime = createRuntimeFromConfig({
      config: parseConfigObject({
        runtime: { dataDir: dir },
        container: { enabled: true },
        permissions: { "container.execute": "allow", "channel.qq.upload_group_file": "allow" }
      }),
      channels,
      logger,
      containerRunner: async (command) =>
        command.args[0] === "rm" ? "" : JSON.stringify({ files: [{ name: "a.txt", base64: "YQ==" }], logs: "" })
    });
    channels.register(
      new OneBot11ChannelAdapter({
        id: "qq",
        transport: "http",
        endpoint: "http://napcat.invalid",
        fetch: async (_url, init) => {
          uploads += 1;
          expect(JSON.parse(init!.body!).params.group_id).toBe("123");
          return Response.json({ status: "ok", retcode: 0, data: { file_id: "uploaded" } });
        }
      })
    );
    const context = {
      runId: "run",
      callId: "call",
      sessionId: "group-a",
      userId: "user",
      source: { channelId: "qq", conversationId: "123", conversationKind: "group" }
    };
    try {
      const work = await runtime.tools.call<{ artifacts: { id: string }[] }>(
        "container.run",
        { script: "pass", outputs: ["a.txt"] },
        context
      );
      const artifactId = work.output!.artifacts[0]!.id;
      await expect(
        runtime.tools.call(
          "artifact.upload",
          { artifactId },
          { ...context, callId: "cross-group", sessionId: "group-b" }
        )
      ).rejects.toThrow("当前会话");
      await expect(
        runtime.tools.call("artifact.upload", { artifactId, groupId: "999" }, { ...context, callId: "forged-target" })
      ).rejects.toThrow("groupId");
      await expect(
        runtime.tools.call(
          "artifact.upload",
          { artifactId },
          { ...context, callId: "private", source: { ...context.source, conversationKind: "private" } }
        )
      ).rejects.toThrow("仅向群聊");
      const uploaded = await runtime.tools.call("artifact.upload", { artifactId }, { ...context, callId: "upload-1" });
      expect(uploaded.output).toMatchObject({ status: "succeeded" });
      await runtime.tools.call("artifact.upload", { artifactId }, { ...context, callId: "upload-2" });
      expect(uploads).toBe(1);
    } finally {
      await runtime.runtime.dispose();
      runtime.contextStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已清理的脚本失败允许同轮修正，默认权限仍拒绝执行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-artifact-repair-"));
    const channels = new InMemoryChannelRegistry();
    channels.register(new OneBot11ChannelAdapter({ id: "qq", endpoint: "ws://unused" }));
    let calls = 0;
    const options = {
      config: parseConfigObject({
        runtime: { dataDir: dir },
        container: { enabled: true },
        permissions: { "container.execute": "allow" }
      }),
      channels,
      logger,
      containerRunner: async (command: Parameters<DockerCommandRunner>[0]) => {
        if (command.args[0] === "rm") return "";
        calls += 1;
        if (calls === 1) throw new Error("script syntax error");
        return JSON.stringify({ files: [{ name: "a.txt", base64: "YQ==" }], logs: "" });
      }
    };
    const instance = createRuntimeFromConfig(options);
    const context = {
      sessionId: "group",
      userId: "user",
      source: { channelId: "qq", conversationId: "123", conversationKind: "group" }
    };
    try {
      const bound = instance.tools.withContext(context);
      expect(
        (await bound.call("container.run", { script: "bad", outputs: ["a.txt"] }, { runId: "r" })).output
      ).toMatchObject({ status: "failed" });
      expect(
        (await bound.call("container.run", { script: "fixed", outputs: ["a.txt"] }, { runId: "r" })).output
      ).toMatchObject({ status: "generated" });
      const denied = createRuntimeFromConfig({
        ...options,
        config: parseConfigObject({ runtime: { dataDir: join(dir, "denied") }, container: { enabled: true } })
      });
      try {
        expect(
          (
            await denied.tools
              .withContext(context)
              .call("container.run", { script: "fixed", outputs: ["a.txt"] }, { runId: "r" })
          ).status
        ).toBe("blocked");
      } finally {
        await denied.runtime.dispose();
        denied.contextStore.close();
      }
      expect(calls).toBe(2);
    } finally {
      await instance.runtime.dispose();
      instance.contextStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("从生产装配完成生成、群文件上传、DAG 回流和重启后的后续对话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-group-artifacts-"));
    let artifactId = "";
    let dockerCalls = 0;
    let uploads = 0;
    let step = 0;
    const modelRequests: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] =
      [];
    const uploadRequests: { group_id: string; name: string; file: string }[] = [];
    const channels = new InMemoryChannelRegistry();
    const fakeDocker: DockerCommandRunner = async (command) => {
      if (command.args[0] === "rm") return "";
      dockerCalls += 1;
      expect(JSON.parse(command.stdin!).script).toBe(script);
      return JSON.stringify({
        files: [{ name: "report.csv", base64: Buffer.from("name,value\n测试,42\n").toString("base64") }],
        logs: "生成成功"
      });
    };
    const config = parseConfigObject({
      runtime: { dataDir: dir },
      container: { enabled: true },
      agent: {
        default: "model",
        providers: {
          model: { type: "openai-compatible", apiKey: "test", baseUrl: "https://model.invalid/v1", model: "test" }
        }
      },
      prompts: {
        enabled: true,
        catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
        defaultPurpose: "reasoning.chat_reply"
      },
      permissions: {
        "container.execute": "allow",
        "channel.qq.upload_group_file": "allow",
        "channel.qq.send_group_message": "allow"
      },
      conversation: { groupTrigger: { mode: "always" } }
    });
    const modelFetch: NonNullable<Parameters<typeof createRuntimeFromConfig>[0]["fetch"]> = async (_url, init) => {
      const body = JSON.parse(init!.body!) as {
        messages: { role: string; content: string }[];
        tools: { function: { name: string } }[];
      };
      step += 1;
      modelRequests.push(body);
      const call = (name: string, args: unknown) =>
        Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: `call-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
                ]
              }
            }
          ]
        });
      if (step === 1) {
        return call("container.run", { script, outputs: ["report.csv"] });
      }
      if (step === 2) {
        const result = JSON.parse(body.messages.at(-1)!.content);
        artifactId = result.output.artifacts[0].id;
        return call("artifact.upload", { artifactId });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "报告已上传群文件" } }] });
    };
    const options = {
      config,
      channels,
      logger,
      fetch: modelFetch,
      // 显式 Docker 验收使用同一产品链路，其余测试只替换容器进程边界
      ...(process.env.SYNAPSE_TEST_DOCKER === "1" ? {} : { containerRunner: fakeDocker })
    };
    let result = createRuntimeFromConfig(options);
    const attach = () =>
      result.runtime.attachChannel(
        new OneBot11ChannelAdapter({
          id: "qq",
          transport: "http",
          endpoint: "http://napcat.invalid",
          fetch: async (_url, init) => {
            const body = JSON.parse(init!.body!);
            if (body.action === "upload_group_file") {
              uploads += 1;
              uploadRequests.push(body.params);
              return Response.json({ status: "ok", retcode: 0, data: { file_id: "qq-file-1" } });
            }
            expect(body.action).toBe("send_msg");
            return Response.json({ status: "ok", retcode: 0, data: { message_id: "reply" } });
          }
        })
      );
    const event: SynapseChannelEvent = {
      id: "event-1",
      platform: "qq",
      channelId: "qq",
      eventType: "message.created",
      conversation: { id: "123", kind: "group" },
      sender: { id: "456" },
      message: textMessage("生成报告并上传群文件"),
      receivedAt: new Date().toISOString()
    };
    try {
      attach();
      await result.runtime.handleChannelEvent(event, "napcat");
      expect(result.runtime.traces.at(-1)?.status).toBe("succeeded");
      expect(uploads).toBe(1);
      expect(step).toBe(3);
      expect(dockerCalls).toBe(process.env.SYNAPSE_TEST_DOCKER === "1" ? 0 : 1);
      expect(modelRequests[0]!.tools.map((tool) => tool.function.name)).toEqual(["artifact.upload", "container.run"]);
      expect(JSON.parse(modelRequests[1]!.messages.at(-1)!.content).output.artifacts[0].name).toBe("report.csv");
      expect(JSON.parse(modelRequests[2]!.messages.at(-1)!.content).output).toMatchObject({
        status: "succeeded",
        fileId: "qq-file-1",
        artifactId
      });
      expect(uploadRequests).toHaveLength(1);
      expect(uploadRequests[0]).toMatchObject({ group_id: "123", name: "report.csv" });
      expect(Buffer.from(uploadRequests[0]!.file.slice("base64://".length), "base64").toString()).toBe(
        "name,value\n测试,42\n"
      );
      await result.runtime.dispose();
      result.contextStore.close();
      channels.unregister("qq");
      result = createRuntimeFromConfig(options);
      attach();
      await result.runtime.handleChannelEvent(event, "napcat");
      expect(step).toBe(3);
      await result.runtime.handleChannelEvent(
        { ...event, id: "event-2", message: textMessage("刚才交付了什么") },
        "napcat"
      );
      expect(step).toBe(4);
      const dag = modelRequests[3]!.messages.find(
        (message) => message.role === "system" && message.content.includes('"commits"')
      );
      expect(dag?.content).toContain(artifactId);
      expect(dag?.content).toContain("qq-file-1");
      expect(dag?.content).not.toContain("from pathlib");
      expect(uploads).toBe(1);
      expect(result.runtime.traces.at(-1)?.status).toBe("succeeded");
    } finally {
      await result.runtime.dispose();
      result.contextStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("配置文件链路保留容器限额，默认关闭并拒绝模型可用的宿主参数", async () => {
    expect(parseConfigObject({}).container.enabled).toBe(false);
    expect(() => parseConfigObject({ container: { enabled: true, mounts: ["/"] } })).toThrow();
    const config = await loadConfigFile(resolve("../../examples/minimal.config.toml"));
    expect(config.container.enabled).toBe(false);
    const example = await loadConfigFile(resolve("../../examples/group-artifacts.config.toml"), {
      env: {
        MODEL_BASE_URL: "https://model.invalid/v1",
        MODEL_API_KEY: "test",
        MODEL_NAME: "test",
        NAPCAT_WS_URL: "ws://localhost:3001",
        NAPCAT_TOKEN: "test",
        QQ_BOT_ID: "123"
      }
    });
    expect(example.container).toMatchObject({ enabled: true, image: "synapse-artifacts:0.1" });
    expect(example.permissions["channel.qq.upload_group_file"]).toBe("allow");
  });

  it("上传回执跨重启去重，开始上传后崩溃不会再次调用平台", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-delivery-"));
    const key = { sessionId: "group", channelId: "qq", groupId: "123", artifactId: "file" };
    let calls = 0;
    try {
      const store = new ArtifactDeliveryStore(dir);
      expect(
        await store.deliver(key, async () => {
          calls += 1;
          return { status: "succeeded", fileId: "qq-file" };
        })
      ).toMatchObject({ status: "succeeded" });
      expect(
        await new ArtifactDeliveryStore(dir).deliver(key, async () => {
          throw new Error("must not upload");
        })
      ).toMatchObject({ status: "succeeded" });
      const unknown = { ...key, artifactId: "unknown" };
      await store.deliver(unknown, async () => {
        calls += 1;
        throw new Error("connection closed");
      });
      expect(
        await new ArtifactDeliveryStore(dir).deliver(unknown, async () => {
          throw new Error("must not upload");
        })
      ).toMatchObject({ status: "uncertain" });
      let finish!: () => void;
      const pending = store.deliver({ ...key, artifactId: "pending" }, async () => {
        calls += 1;
        await new Promise<void>((complete) => {
          finish = complete;
        });
        return { status: "succeeded" };
      });
      expect(
        await new ArtifactDeliveryStore(dir).deliver({ ...key, artifactId: "pending" }, async () => {
          throw new Error("must not upload");
        })
      ).toMatchObject({ status: "uncertain" });
      finish();
      await pending;
      expect(calls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
