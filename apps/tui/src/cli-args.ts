import type { RuntimeConsoleOptions } from "./console/types.js";

/** 解析独立 TUI 参数，本地启动参数只负责传递给 Runtime 进程 */
export function parseTuiArgs(args: readonly string[], onHelp: () => never): RuntimeConsoleOptions {
  const options: Record<string, string | boolean> = { configPath: "runtime.config.toml" };
  const names: Record<string, string> = {
    "--endpoint": "endpoint",
    "--token": "token",
    "--profile": "profile",
    "--profile-config": "profilePath",
    "--runtime-entry": "runtimeEntry",
    "--config": "configPath",
    "-c": "configPath",
    "--env-file": "envFile",
    "--workspace-config": "workspaceConfigPath",
    "--user-config": "userConfigPath"
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") onHelp();
    if (arg === "--spawn") {
      options.spawn = true;
      continue;
    }
    const name = names[arg];
    if (name === undefined) throw new Error(`Unknown argument "${arg}"`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[name] = value;
  }
  if (options.spawn) {
    if (!options.runtimeEntry) throw new Error("--spawn requires --runtime-entry <runtime cli.js>");
    if (options.endpoint || options.token || options.profile || options.profilePath) {
      throw new Error("--spawn cannot be combined with remote connection options");
    }
  } else if (
    args.some((arg) =>
      ["--runtime-entry", "--config", "-c", "--env-file", "--workspace-config", "--user-config"].includes(arg)
    )
  ) {
    throw new Error("Runtime launch options require --spawn");
  }
  return options as unknown as RuntimeConsoleOptions;
}
