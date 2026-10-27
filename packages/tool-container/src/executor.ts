import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ArtifactNameSchema,
  ContainerSettingsSchema,
  ContainerWorkInputSchema,
  type ContainerSettings
} from "./config.js";
import type { ArtifactContent } from "./artifacts.js";
import { PYTHON_RUNNER } from "./python-runner.js";

/** Docker 子进程调用契约，参数数组不会经过宿主 Shell */
export interface DockerCommand {
  /** 运行截止或退出时终止受控 Docker 客户端 */
  readonly signal?: AbortSignal;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** 可替换的进程边界用于故障注入，生产环境默认调用本地 Docker CLI */
export type DockerCommandRunner = (command: DockerCommand) => Promise<string>;

/** 本地容器的有界执行结果，只有声明的工件会离开容器 */
export interface ContainerExecutionResult {
  readonly files: readonly ArtifactContent[];
  readonly logs: string;
}

/** 在无网络、无宿主挂载的容器内运行 Python 文件生成任务 */
export class ContainerExecutor {
  readonly #settings: ContainerSettings;
  #active = 0;

  /** 配置由部署者提供，执行器不会下载镜像或接受模型给出的 Docker 参数 */
  constructor(
    settings: ContainerSettings,
    private readonly runCommand: DockerCommandRunner = runDockerCommand
  ) {
    this.#settings = ContainerSettingsSchema.parse(settings);
  }

  /** 执行独立工作任务，失败、超时和正常完成均尝试移除本次拥有的容器 */
  async execute(
    input: { readonly script: string; readonly outputs: readonly string[] },
    inputs: readonly ArtifactContent[] = [],
    signal?: AbortSignal
  ): Promise<ContainerExecutionResult> {
    const request = ContainerWorkInputSchema.parse(input);
    signal?.throwIfAborted();
    const limits = this.#settings;
    if (!limits.enabled) throw new Error("容器能力未启用");
    if (request.outputs.length > limits.maxArtifacts || inputs.length > limits.maxArtifacts)
      throw new Error("工件数量超限");
    let inputBytes = 0;
    const names = new Set<string>();
    for (const file of inputs) {
      ArtifactNameSchema.parse(file.name);
      if (names.has(file.name)) throw new Error("输入工件名称重复");
      names.add(file.name);
      inputBytes += file.data.byteLength;
      if (file.data.byteLength > limits.maxArtifactBytes) throw new Error("输入工件大小超限");
    }
    if (inputBytes > limits.maxTotalBytes) throw new Error("输入工件总大小超限");
    if (this.#active >= limits.maxConcurrent) throw new Error("容器并发额度已满，请稍后再试");
    this.#active += 1;
    const name = `synapse-work-${randomUUID()}`;
    let failure: unknown;
    let execution: ContainerExecutionResult | undefined;
    try {
      const raw = await this.runCommand({
        ...(signal ? { signal } : {}),
        args: [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--label",
          "synapse.work=true",
          "--interactive",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65534:65534",
          "--pids-limit=64",
          `--memory=${limits.memoryMiB}m`,
          `--memory-swap=${limits.memoryMiB}m`,
          `--cpus=${limits.cpus}`,
          "--init",
          "--ulimit",
          "nofile=128:128",
          "--log-driver=none",
          "--tmpfs",
          `/work:rw,nosuid,nodev,noexec,size=${limits.workspaceMiB}m,mode=1777`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
          "--workdir=/work",
          "--env",
          "HOME=/work",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--entrypoint=python3",
          limits.image,
          "-I",
          "-c",
          PYTHON_RUNNER
        ],
        stdin: JSON.stringify({
          ...request,
          ...limits,
          inputs: inputs.map((file) => ({ name: file.name, base64: Buffer.from(file.data).toString("base64") }))
        }),
        timeoutMs: limits.timeoutMs + 15_000,
        // base64 与 JSON 转义需要额外空间，宿主仍对返回总量执行硬限制
        maxBytes: Math.ceil((limits.maxTotalBytes * 4) / 3) + limits.maxLogBytes * 6 + 16_384
      });
      const result = z
        .object({
          files: z.array(z.object({ name: ArtifactNameSchema, base64: z.string() }).strict()),
          logs: z.string()
        })
        .strict()
        .parse(JSON.parse(raw));
      if (result.files.length !== request.outputs.length || Buffer.byteLength(result.logs) > limits.maxLogBytes)
        throw new Error("容器返回的工件或日志数量不符合声明");
      const files = result.files.map((file, index) => {
        if (file.name !== request.outputs[index] || file.base64.length > Math.ceil(limits.maxArtifactBytes / 3) * 4)
          throw new Error("容器返回无效工件");
        const data = Buffer.from(file.base64, "base64");
        // 重新编码校验规范形式，避免大文件在重复分组正则中耗尽调用栈
        if (data.toString("base64") !== file.base64) throw new Error("容器返回无效工件编码");
        if (data.length > limits.maxArtifactBytes) throw new Error("容器返回的工件超限");
        return { name: file.name, data };
      });
      if (files.reduce((sum, file) => sum + file.data.length, 0) > limits.maxTotalBytes)
        throw new Error("容器返回的工件总大小超限");
      execution = { files, logs: result.logs };
    } catch (error) {
      failure = error ?? new Error("容器执行失败");
    } finally {
      try {
        await this.runCommand({ args: ["rm", "--force", name], timeoutMs: 10_000, maxBytes: 4096 });
      } catch (cleanupError) {
        // --rm 正常退出后容器可能已经不存在，除此之外清理失败必须暴露给调用者
        if (!(cleanupError instanceof Error && /No such container/i.test(cleanupError.message))) {
          failure = new AggregateError(
            [...(failure === undefined ? [] : [failure]), cleanupError],
            "容器清理失败，需检查 Docker 状态",
            { cause: cleanupError }
          );
        }
      } finally {
        this.#active -= 1;
      }
    }
    if (failure !== undefined) throw failure;
    return execution!;
  }
}

/** 启动受限 Docker 命令，超时和输出超限会终止客户端并由执行器清理容器 */
export function runDockerCommand(command: DockerCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    command.signal?.throwIfAborted();
    const child = spawn("docker", [...command.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const timer = setTimeout(() => finish(new Error("容器执行超时")), command.timeoutMs);
    const abort = () => finish(new Error("容器执行已取消"));
    command.signal?.addEventListener("abort", abort, { once: true });
    if (command.signal?.aborted) abort();
    const collect = (target: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > command.maxBytes) {
        finish(new Error("容器输出超限"));
        return;
      }
      if (!settled) target.push(data);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`Docker 执行失败 (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 4096)}`)
      )
    );
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(command.stdin);
  });
}
