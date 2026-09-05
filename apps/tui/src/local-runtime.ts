import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import type { RuntimeConsoleOptions } from "./console/types.js";

/** 管理 TUI 自己启动的 Runtime，业务操作始终通过 Admin API */
export class LocalRuntimeProcess {
  #child: ChildProcess | undefined;
  #stopping: Promise<void> | undefined;

  constructor(private readonly options: RuntimeConsoleOptions) {}

  /** 等待独立进程报告实际监听地址，令牌通过环境传递避免出现在命令行 */
  async start(signal: AbortSignal): Promise<{ endpoint: string; token: string }> {
    signal.throwIfAborted();
    if (this.#child) throw new Error("Runtime process already started");
    if (!this.options.runtimeEntry) throw new Error("--spawn requires --runtime-entry");
    const token = randomBytes(32).toString("hex");
    const args = [resolve(this.options.runtimeEntry), "serve", "--config", this.options.configPath];
    for (const [flag, value] of [
      ["--env-file", this.options.envFile],
      ["--workspace-config", this.options.workspaceConfigPath],
      ["--user-config", this.options.userConfigPath]
    ]) {
      if (flag && value) args.push(flag, value);
    }
    args.push("--admin-host", "127.0.0.1", "--admin-port", "0", "--admin-token-env", "SYNAPSE_TUI_ADMIN_TOKEN");
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, SYNAPSE_TUI_ADMIN_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.#child = child;
    // 启动日志不直接写终端，以免破坏 Ink 渲染或泄露环境配置；连接后从脱敏日志 API 读取
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      return await new Promise<{ endpoint: string; token: string }>((resolveReady, reject) => {
        const timeout = setTimeout(() => finish(new Error("Runtime startup timed out")), 30_000);
        const onAbort = () => finish(new Error("Runtime startup cancelled"));
        const onExit = () => finish(new Error("Runtime exited before Admin API became ready; check its configuration"));
        const onError = (error: Error) => finish(error);
        const onMessage = (message: unknown) => {
          if (typeof message !== "object" || message === null) return;
          const ready = message as Record<string, unknown>;
          if (
            ready.type !== "synapse:runtime-ready" ||
            !Number.isInteger(ready.adminPort) ||
            Number(ready.adminPort) <= 0 ||
            Number(ready.adminPort) > 65535
          )
            return;
          finish(undefined, { endpoint: `http://127.0.0.1:${ready.adminPort}`, token });
        };
        const finish = (error?: Error, value?: { endpoint: string; token: string }) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          child.off("message", onMessage);
          child.off("exit", onExit);
          child.off("error", onError);
          if (error) reject(error);
          else if (value) resolveReady(value);
        };
        child.on("message", onMessage);
        child.once("exit", onExit);
        child.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** 仅关闭所拥有的子进程，IPC 断开触发服务端优雅停机，超时才终止进程 */
  stop(): Promise<void> {
    return (this.#stopping ??= this.#stopChild());
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return;
    }
    // Windows 的 IPC 主动断开后可能不再发出 close；以进程 exit 为回收完成依据
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill(), 5_000);
    try {
      if (child.connected) child.disconnect();
      else child.kill();
      await exited;
    } finally {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}
