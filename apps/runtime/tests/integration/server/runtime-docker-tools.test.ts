import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import type { DockerCommand } from "@synapse/runtime-tool-execution";
import { onTestFinished, describe, expect, it, vi } from "vitest";
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

describe("生产 Docker 交付闭环", () => {
  it.each([
    { mediaPermission: "allow", uploadPermission: "allow" },
    { mediaPermission: "deny", uploadPermission: "allow" },
    { mediaPermission: "allow", uploadPermission: "deny" }
  ] as const)(
    "媒体权限为 $mediaPermission、上传权限为 $uploadPermission 时保持执行与展示分离",
    async ({ mediaPermission, uploadPermission }) => {
      const dataDir = mkdtempSync(join(tmpdir(), "synapse-docker-loop-"));
      onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
      const attachment = { type: "file", name: "demo.pptx", url: "base64://aGk=", sizeBytes: 2 };
      dockerMock.command
        .mockReset()
        .mockResolvedValueOnce(
          JSON.stringify({
            schemaVersion: "runtime-tool-output/v1",
            modelOutput: { exitCode: 0, artifacts: [{ name: "demo.pptx", sizeBytes: 2 }] },
            attachments: [attachment]
          })
        )
        .mockResolvedValueOnce("");
      const uploads: { action: string; params: unknown }[] = [];
      const channel = new OneBot11ChannelAdapter({
        id: "qq-local",
        transport: "http",
        endpoint: "http://localhost:5700",
        fetch: async (_url, init) => {
          uploads.push(JSON.parse(String(init?.body)));
          return Response.json({ status: "ok", retcode: 0, data: { message_id: "sent-1" } });
        }
      });
      let modelCalls = 0;
      const config = parseConfigObject({
        runtime: { dataDir },
        tools: { docker: { enabled: true } },
        prompts: {
          enabled: true,
          catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
          defaultPurpose: "reasoning.chat_reply"
        },
        agent: {
          default: "qwen",
          providers: {
            qwen: { type: "openai-compatible", apiKey: "test-key", baseUrl: "http://model.test", model: "qwen" }
          }
        },
        conversation: { groupTrigger: { mode: "always" } },
        permissions: {
          "execution.docker.run": "allow",
          "channel.qq.send_group_message": "allow",
          "channel.qq.send_media": mediaPermission,
          "channel.qq.upload_group_file": uploadPermission
        }
      });
      const result = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: { info() {}, warn() {}, error() {} },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          modelCalls += 1;
          expect(body.messages.some((message: { content: string }) => message.content?.includes("base64://aGk="))).toBe(
            false
          );
          expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("docker.run");
          if (modelCalls === 1) {
            return Response.json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "create-ppt",
                        type: "function",
                        function: {
                          name: "docker.run",
                          arguments: JSON.stringify({
                            command: "python create_ppt.py",
                            artifacts: [{ path: "demo.pptx" }]
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ]
            });
          }
          expect(body.messages.at(-1).content).toContain("demo.pptx");
          return Response.json({ choices: [{ message: { content: "**制作完成**" }, finish_reason: "stop" }] });
        }
      });
      try {
        result.runtime.attachChannel(channel);
        await channel.handlePayload({
          post_type: "message",
          message_type: "group",
          message_id: 1,
          group_id: 42,
          user_id: 7,
          message: "生成 PPT 并发送",
          sender: { nickname: "tester" }
        });
        expect(modelCalls).toBe(2);
        expect(dockerMock.command).toHaveBeenCalledTimes(2);
        const expectedUploads =
          mediaPermission === "allow" && uploadPermission === "allow"
            ? [
                {
                  action: "upload_group_file",
                  params: { group_id: "42", name: "demo.pptx", file: attachment.url, upload_file: true }
                },
                {
                  action: "send_msg",
                  params: {
                    message_type: "group",
                    group_id: "42",
                    message: "制作完成",
                    auto_escape: false
                  }
                }
              ]
            : [];
        expect(uploads).toEqual(expectedUploads);
        expect(result.runtime.traces.at(-1)?.status).toBe(
          mediaPermission === "allow" && uploadPermission === "allow" ? "succeeded" : "blocked"
        );
      } finally {
        await result.runtime.dispose();
        result.contextStore.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  );

  it("网页工具禁用时仍独立注册 Docker", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-docker-registration-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const result = createRuntimeFromConfig({
      config: parseConfigObject({ runtime: { dataDir }, tools: { docker: { enabled: true } } }),
      channels: new InMemoryChannelRegistry(),
      logger: { info() {}, warn() {}, error() {} }
    });
    try {
      expect(result.tools.list().map((tool) => tool.name)).toEqual(["docker.run"]);
    } finally {
      await result.runtime.dispose();
      result.contextStore.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
