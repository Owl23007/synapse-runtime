import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onTestFinished, describe, expect, it, vi } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import type { DockerCommand } from "@synapse/runtime-tool-execution";
import { parseConfigObject } from "../../../src/config/index.js";
import { createRuntimeFromConfig } from "../../../src/server/runtime-factory.js";

const dockerMock = vi.hoisted(() => ({ command: vi.fn<DockerCommand>() }));
vi.mock("@synapse/runtime-tool-execution", async (load) => {
  const actual = await load<typeof import("@synapse/runtime-tool-execution")>();
  return {
    ...actual,
    createDockerTool: (settings: Parameters<typeof actual.createDockerTool>[0]) =>
      actual.createDockerTool(settings, dockerMock.command)
  };
});

describe("最终产物交付闭环", () => {
  it.each([false, true])("去重、替换和废弃后只上传最终版本，回复失败=%s 不抹去上传回执", async (failReply) => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-final-delivery-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const generated = ["v1", "v1", "v2", "draft"];
    let executions = 0;
    dockerMock.command.mockReset().mockImplementation(async (args) => {
      if (args[0] === "rm") return "";
      const data = generated[executions++]!;
      return JSON.stringify({
        schemaVersion: "runtime-tool-output/v1",
        modelOutput: { exitCode: 0 },
        attachments: [
          {
            type: "file",
            name: data === "draft" ? "draft.txt" : "report.txt",
            url: `base64://${Buffer.from(data).toString("base64")}`
          }
        ]
      });
    });
    const config = parseConfigObject({
      runtime: { dataDir: directory },
      tools: { docker: { enabled: true } },
      conversation: { groupTrigger: { mode: "always" } },
      prompts: {
        enabled: true,
        catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
        defaultPurpose: "reasoning.chat_reply"
      },
      agent: {
        default: "model",
        providers: {
          model: { type: "openai-compatible", apiKey: "test-key", baseUrl: "https://model.invalid", model: "test" }
        }
      },
      permissions: {
        "execution.docker.run": "allow",
        "channel.qq.send_group_message": "allow",
        "channel.qq.send_media": "allow",
        "channel.qq.upload_group_file": "allow"
      }
    });
    let step = 0;
    const ids: string[] = [];
    const instance = createRuntimeFromConfig({
      config,
      channels: new InMemoryChannelRegistry(),
      logger: { info() {}, warn() {}, error() {} },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (step > 0 && step <= 4) ids.push(JSON.parse(body.messages.at(-1).content).output.artifacts[0].id);
        const input =
          step < 4
            ? { command: "generate", artifacts: [{ path: step === 3 ? "draft.txt" : "report.txt" }] }
            : step === 4
              ? { discardArtifactIds: [ids[3]] }
              : { selectArtifactIds: [ids[2]] };
        const message =
          step < 6
            ? {
                content: "",
                tool_calls: [
                  {
                    id: `step-${step}`,
                    type: "function",
                    function: { name: "docker.run", arguments: JSON.stringify(input) }
                  }
                ]
              }
            : { content: "最终报告已完成" };
        step++;
        return Response.json({ choices: [{ message }] });
      }
    });
    const actions: { action: string; params: Record<string, unknown> }[] = [];
    const channel = new OneBot11ChannelAdapter({
      id: "qq",
      endpoint: "https://napcat.invalid",
      transport: "http",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        actions.push(request);
        return Response.json(
          failReply && request.action === "send_msg"
            ? { status: "failed", retcode: 100, wording: "reply rejected" }
            : { status: "ok", retcode: 0, data: { file_id: "uploaded", message_id: "reply" } }
        );
      }
    });
    instance.runtime.attachChannel(channel);
    try {
      await channel.handlePayload({
        post_type: "message",
        message_type: "group",
        message_id: 1,
        group_id: 42,
        user_id: 7,
        message: "修订报告并只交付最终版本"
      });
      expect(executions).toBe(4);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
      expect(actions.map((action) => action.action)).toEqual(["upload_group_file", "send_msg"]);
      expect(actions[0]!.params).toMatchObject({
        name: "report.txt",
        file: `base64://${Buffer.from("v2").toString("base64")}`
      });
      const run = instance.contextStore.runs.list().items[0]!;
      expect(run.status).toBe(failReply ? "failed" : "succeeded");
      const events = instance.contextStore.runs.events(run.id, 0, 200);
      expect(events.filter((event) => event.type === "artifact_upload_succeeded")).toHaveLength(1);
      expect(events.some((event) => event.type === "artifact_selection_changed")).toBe(true);
      const artifacts = new ArtifactStore(join(directory, "artifacts"), config.container);
      expect(artifacts.list(run.sessionId).items).toHaveLength(3);
      expect(artifacts.describe(run.sessionId, ids[3]!).disposition).toBe("discarded");
      expect(artifacts.selection(run.sessionId, run.id).selectedIds).toEqual([ids[2]]);
    } finally {
      await instance.runtime.dispose();
      instance.contextStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
