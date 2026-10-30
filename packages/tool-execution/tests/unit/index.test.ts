import { describe, expect, it, vi } from "vitest";
import { createDockerTool, type DockerCommand } from "../../src/index.js";
import { DockerToolSettingsSchema } from "../../src/config.js";

const context = { runId: "run-1", sessionId: "session-1", userId: "user-1" };
const settings = DockerToolSettingsSchema.parse({ enabled: true });

describe("Docker 执行", () => {
  it("隔离命令、返回已验证交付数据并清理同一容器", async () => {
    const result = {
      schemaVersion: "runtime-tool-output/v1",
      modelOutput: { exitCode: 0 },
      attachments: [{ type: "file", name: "demo.txt", url: "base64://aGk=" }]
    };
    const command = vi.fn<DockerCommand>().mockResolvedValueOnce(JSON.stringify(result)).mockResolvedValueOnce("");
    const tool = createDockerTool(settings, command);
    await expect(
      tool.handle({ command: "printf hi > demo.txt", artifacts: [{ path: "demo.txt" }] }, context)
    ).resolves.toEqual(result);
    const [args, input] = command.mock.calls[0]!;
    expect(args).toEqual(
      expect.arrayContaining(["--network=none", "--read-only", "--pull=never", "--user=65534:65534", "--cap-drop=ALL"])
    );
    expect(args).not.toContain("printf hi > demo.txt");
    expect(JSON.parse(input)).toMatchObject({
      command: "printf hi > demo.txt",
      artifacts: [{ path: "demo.txt", type: "file" }]
    });
    expect(command.mock.calls[1]![0]).toEqual(["rm", "--force", args[args.indexOf("--name") + 1]]);
  });

  it("清理超时容器并保留执行错误", async () => {
    const command = vi
      .fn<DockerCommand>()
      .mockRejectedValueOnce(new Error("Docker execution timed out"))
      .mockRejectedValueOnce(new Error("No such container"));
    await expect(createDockerTool(settings, command).handle({ command: "sleep 99" }, context)).rejects.toThrow(
      "timed out"
    );
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("启动 Docker 前拒绝路径穿越", async () => {
    const command = vi.fn<DockerCommand>();
    await expect(
      createDockerTool(settings, command).handle({ command: "true", artifacts: [{ path: "../../secret" }] }, context)
    ).rejects.toThrow("relative to /workspace");
    expect(command).not.toHaveBeenCalled();
  });

  it("拒绝格式错误的运行器交付且仍执行清理", async () => {
    const command = vi
      .fn<DockerCommand>()
      .mockResolvedValueOnce(
        '{"schemaVersion":"runtime-tool-output/v1","modelOutput":{},"attachments":[{"type":"file","name":"secret","url":"file:///secret"}]}'
      )
      .mockResolvedValueOnce("");
    await expect(createDockerTool(settings, command).handle({ command: "true" }, context)).rejects.toThrow(
      "invalid result"
    );
    expect(command).toHaveBeenCalledTimes(2);
  });
});
