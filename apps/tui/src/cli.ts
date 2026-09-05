#!/usr/bin/env node
import { parseTuiArgs } from "./cli-args.js";

async function main(): Promise<void> {
  const options = parseTuiArgs(process.argv.slice(2), () => {
    console.log(`Usage: synapse-tui [options]

  --endpoint <url>         连接已有 Runtime 的 Admin API
  --token <token>          Admin API 令牌
  --profile <name>         使用连接配置
  --profile-config <path>  连接配置文件
  --spawn                 启动并管理独立 Runtime 子进程
  --runtime-entry <path>   Runtime 的 cli.js 路径，--spawn 必填
  -c, --config <path>      传给 Runtime 的应用配置
  --workspace-config <p>   传给 Runtime 的工作区配置
  --user-config <path>     传给 Runtime 的用户配置
  --env-file <path>        由 Runtime 加载的环境文件
  -h, --help              显示帮助

退出时断开连接；仅 --spawn 启动的进程随 TUI 关闭。`);
    process.exit(0);
  });
  const { startRuntimeConsole } = await import("./console/start.js");
  await startRuntimeConsole(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
