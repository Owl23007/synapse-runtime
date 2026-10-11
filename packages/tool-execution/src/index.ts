import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Tool } from "@synapse/runtime-tool-runtime";
import { readToolOutput } from "@synapse/runtime-protocol";
import { z } from "zod";
import { DockerToolSettingsSchema, type DockerToolSettings } from "./config.js";
import { runnerScript } from "./runner.js";

const inputSchema = z
  .object({
    command: z.string().min(1).max(100_000),
    artifacts: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .refine(
                (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
                "Artifact path must be relative to /workspace"
              ),
            type: z.enum(["file", "image"]).default("file")
          })
          .strict()
      )
      .max(8)
      .default([])
  })
  .strict();

/** Docker 进程调用接口，可替换为测试进程而不启动真实容器 */
export type DockerCommand = (
  args: readonly string[],
  input: string,
  timeoutMs: number,
  maxBytes: number
) => Promise<string>;

/** 创建按需启动并回收的 Docker 执行工具，只向模型返回文本观察和产物元数据 */
export function createDockerTool(settings: DockerToolSettings, command: DockerCommand = runDocker): Tool {
  const config = DockerToolSettingsSchema.parse(settings);
  return {
    name: "docker.run",
    description:
      "在隔离 Docker 容器中实际执行 shell 命令，工作目录 /workspace，包含 Python、python-pptx、Pillow、openpyxl、reportlab、matplotlib。每次调用是全新容器，无网络，不保留文件。把需交付的相对文件路径写入 artifacts（图片标记 image）；成功生成的文件会自动附加到本轮回复，不能用文件名或假装已发送代替。",
    permission: { action: "execution.docker.run", resource: config.image },
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 100000 },
        artifacts: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: { path: { type: "string", minLength: 1 }, type: { type: "string", enum: ["file", "image"] } },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      required: ["command"],
      additionalProperties: false
    },
    async handle(input) {
      const parsed = inputSchema.parse(input);
      const name = `synapse-execution-${randomUUID()}`;
      try {
        const stdout = await command(
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=128",
            `--memory=${config.memoryMb}m`,
            `--cpus=${config.cpus}`,
            "--user=65534:65534",
            "--tmpfs=/workspace:rw,nosuid,nodev,size=128m,mode=1777",
            "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
            "--workdir=/workspace",
            "--env=HOME=/tmp",
            "--env=MPLCONFIGDIR=/tmp/matplotlib",
            "--interactive",
            "--entrypoint=python",
            config.image,
            "-c",
            runnerScript
          ],
          JSON.stringify({ ...parsed, timeoutMs: config.timeoutMs, maxArtifactBytes: config.maxArtifactBytes }),
          config.timeoutMs + 10_000,
          Math.ceil((config.maxArtifactBytes * 4) / 3) + 200_000
        );
        const output: unknown = JSON.parse(stdout);
        if (readToolOutput(output) === undefined) throw new Error("Docker runner returned an invalid result");
        return output;
      } finally {
        // 超时杀死 CLI 不保证容器退出，必须用独立调用清理具名容器
        await command(["rm", "--force", name], "", 10_000, 24_000).catch((error: unknown) => {
          if (!(error instanceof Error) || !/No such container/i.test(error.message)) throw error;
        });
      }
    }
  };
}

function runDocker(args: readonly string[], input: string, timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Docker execution timed out");
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr]
    ] as const) {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > maxBytes) {
          failure = new Error("Docker output exceeded its size limit");
          child.kill();
        } else chunks.push(data);
      });
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) reject(failure);
      else if (code !== 0)
        reject(new Error(`Docker failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 24000)}`));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
}
