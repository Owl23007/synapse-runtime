import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import type { DockerCommand } from "@synapse/runtime-tool-execution";
import { parseConfigObject } from "../config/index.js";
import { createRuntimeFromConfig } from "./runtime-factory.js";

const fixture = vi.hoisted(() => ({ command: vi.fn<DockerCommand>() }));
vi.mock("@synapse/runtime-tool-execution", async (load) => {
  const actual = await load<typeof import("@synapse/runtime-tool-execution")>();
  return {
    ...actual,
    createDockerTool: (settings: Parameters<typeof actual.createDockerTool>[0]) =>
      actual.createDockerTool(settings, fixture.command)
  };
});

describe("统一 Docker 工件持久边界", () => {
  it("Docker 文件保存为工件，工具、模型、回复、DAG 与 SQLite 不携带 Base64", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-unified-artifacts-"));
    const content = Buffer.from("unique-artifact-content-672891");
    const url = `base64://${content.toString("base64")}`;
    fixture.command
      .mockReset()
      .mockResolvedValueOnce(
        JSON.stringify({
          schemaVersion: "runtime-tool-output/v1",
          modelOutput: { exitCode: 0 },
          attachments: [{ type: "file", name: "report.txt", url }]
        })
      )
      .mockResolvedValueOnce("");
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
          model: { type: "openai-compatible", apiKey: "test", baseUrl: "https://model.invalid", model: "test" }
        }
      },
      permissions: {
        "execution.docker.run": "allow",
        "channel.qq.send_group_message": "allow",
        "channel.qq.send_media": "allow",
        "channel.qq.upload_group_file": "allow"
      }
    });
    let requests = 0;
    const instance = createRuntimeFromConfig({
      config,
      channels: new InMemoryChannelRegistry(),
      logger: { info() {}, warn() {}, error() {} },
      fetch: async (_url, init) => {
        expect(String(init?.body)).not.toContain("base64://");
        return Response.json({
          choices: [
            {
              message:
                requests++ === 0
                  ? {
                      content: "",
                      tool_calls: [
                        {
                          id: "generate",
                          type: "function",
                          function: {
                            name: "docker.run",
                            arguments: '{"command":"generate","artifacts":[{"path":"report.txt"}]}'
                          }
                        }
                      ]
                    }
                  : { content: "完成" }
            }
          ]
        });
      }
    });
    const sent: string[] = [];
    const channel = new OneBot11ChannelAdapter({
      id: "qq",
      endpoint: "https://napcat.invalid",
      transport: "http",
      fetch: async (_url, init) => {
        sent.push(String(init?.body));
        return Response.json({ status: "ok", retcode: 0, data: { message_id: "reply" } });
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
        message: "生成报告"
      });
      const run = instance.contextStore.runs.list().items[0]!;
      const artifacts = new ArtifactStore(join(directory, "artifacts"), config.container);
      const saved = artifacts.list(run.sessionId).items;
      expect(saved).toHaveLength(1);
      expect(artifacts.read(run.sessionId, saved[0]!.id).data).toEqual(content);
      expect(JSON.stringify(instance.contextStore.runs.events(run.id))).not.toContain("base64://");
      expect(JSON.stringify(await instance.contextStore.listEvents(run.lineId!))).not.toContain("base64://");
      expect(sent.some((body) => body.includes(url))).toBe(true);
      await instance.runtime.dispose();
      instance.contextStore.close();
      const database = readFileSync(join(directory, "runtime-context.sqlite"));
      expect(database.includes(Buffer.from(content.toString("base64")))).toBe(false);
      expect(database.includes(Buffer.from("artifact://"))).toBe(true);
    } finally {
      await instance.runtime.dispose();
      instance.contextStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
