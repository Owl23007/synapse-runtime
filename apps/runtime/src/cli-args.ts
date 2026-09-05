import type { ConfigCliOptions } from "./config/cli-options.js";
/** CLI 支持的命令类型 */
export type CliCommand =
  | "start"
  | "serve"
  | "console"
  | "status"
  | "logs"
  | "channels"
  | "channel"
  | "reload"
  | "shutdown"
  | "connect"
  | "profiles"
  | "use";

/** 已解析的 CLI 选项 */
export interface CliOptions extends ConfigCliOptions {
  readonly command: CliCommand;
  readonly configPath: string;
  readonly envFile?: string;
  readonly adminHost?: string;
  readonly adminPort?: number;
  readonly adminTokenEnv?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly tail?: number;
  readonly profile?: string;
  readonly profilePath?: string;
  readonly spawn?: boolean;
  readonly channelAction?: "enable" | "disable";
  readonly channelId?: string;
  readonly positional?: readonly string[];
}

/** CLI 允许的命令集合，集中维护以避免解析逻辑与类型定义分叉 */
const CLI_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "serve",
  "console",
  "status",
  "logs",
  "channels",
  "channel",
  "reload",
  "shutdown",
  "connect",
  "profiles",
  "use"
]);

/** 解析 CLI 参数
 *
 * @param args 待解析的参数列表
 * @param onHelp 收到帮助参数时执行的回调，回调应结束当前进程
 * @returns 结构化 CLI 选项
 */
export function parseArgs(args: readonly string[], onHelp: () => never): CliOptions {
  let command: CliCommand = "start";
  let configPath = "runtime.config.toml";
  let workspaceConfigPath: string | undefined;
  let userConfigPath: string | undefined;
  let envFile: string | undefined;
  let adminHost: string | undefined;
  let adminPort: number | undefined;
  let adminTokenEnv: string | undefined;
  let endpoint: string | undefined;
  let token: string | undefined;
  let tail: number | undefined;
  let profile: string | undefined;
  let profilePath: string | undefined;
  let spawn = false;
  let channelAction: CliOptions["channelAction"];
  let channelId: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && isCliCommand(arg)) {
      command = arg;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      onHelp();
    }

    if (arg === "--config" || arg === "-c") {
      configPath = readRequiredValue(args, index, `${arg} requires a file path.`);
      index += 1;
      continue;
    }

    if (arg === "--workspace-config" || arg === "--user-config") {
      const path = readRequiredValue(args, index, `${arg} requires a file path.`);
      if (arg === "--workspace-config") workspaceConfigPath = path;
      else userConfigPath = path;
      index += 1;
      continue;
    }

    if (arg === "--env-file") {
      envFile = readRequiredValue(args, index, "--env-file requires a file path.");
      index += 1;
      continue;
    }

    if (arg === "--admin-host") {
      adminHost = readRequiredValue(args, index, "--admin-host requires a host value.");
      index += 1;
      continue;
    }

    if (arg === "--admin-port") {
      const value = readRequiredValue(args, index, "--admin-port requires a port value.");
      const port = Number.parseInt(value, 10);

      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--admin-port must be an integer between 0 and 65535.");
      }

      adminPort = port;
      index += 1;
      continue;
    }

    if (arg === "--admin-token-env") {
      adminTokenEnv = readRequiredValue(args, index, "--admin-token-env requires an environment variable name.");
      index += 1;
      continue;
    }

    if (arg === "--endpoint") {
      endpoint = readRequiredValue(args, index, "--endpoint requires a URL.");
      index += 1;
      continue;
    }

    if (arg === "--profile") {
      profile = readRequiredValue(args, index, "--profile requires a profile name.");
      index += 1;
      continue;
    }

    if (arg === "--profile-config") {
      profilePath = readRequiredValue(args, index, "--profile-config requires a file path.");
      index += 1;
      continue;
    }

    if (arg === "--spawn") {
      spawn = true;
      continue;
    }

    if (arg === "--token") {
      token = readRequiredValue(args, index, "--token requires a token.");
      index += 1;
      continue;
    }

    if (arg === "--tail" || arg === "--limit") {
      tail = parsePositiveInt(readRequiredValue(args, index, `${arg} requires a positive integer.`), arg);
      index += 1;
      continue;
    }

    if (arg !== undefined && !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    throw new Error(`Unknown argument "${arg}".`);
  }

  if (command === "connect" && endpoint === undefined && positional[0] !== undefined) {
    endpoint = positional[0];
  }

  if (command === "use" && profile === undefined && positional[0] !== undefined) {
    profile = positional[0];
  }

  if (command === "channel") {
    const action = positional[0];

    if (action !== "enable" && action !== "disable") {
      throw new Error('channel command requires "enable" or "disable".');
    }

    if (positional[1] === undefined) {
      throw new Error("channel command requires a channel id.");
    }

    channelAction = action;
    channelId = positional[1];
  }

  return {
    command,
    configPath,
    ...(workspaceConfigPath === undefined ? {} : { workspaceConfigPath }),
    ...(userConfigPath === undefined ? {} : { userConfigPath }),
    ...(envFile === undefined ? {} : { envFile }),
    ...(adminHost === undefined ? {} : { adminHost }),
    ...(adminPort === undefined ? {} : { adminPort }),
    ...(adminTokenEnv === undefined ? {} : { adminTokenEnv }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(token === undefined ? {} : { token }),
    ...(tail === undefined ? {} : { tail }),
    ...(profile === undefined ? {} : { profile }),
    ...(profilePath === undefined ? {} : { profilePath }),
    ...(spawn ? { spawn } : {}),
    ...(channelAction === undefined ? {} : { channelAction }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(positional.length === 0 ? {} : { positional })
  };
}

function isCliCommand(value: string | undefined): value is CliCommand {
  return value !== undefined && CLI_COMMANDS.has(value);
}

function readRequiredValue(args: readonly string[], index: number, missingMessage: string): string {
  const value = args[index + 1];

  if (value === undefined) {
    throw new Error(missingMessage);
  }

  return value;
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} requires a positive integer.`);
  }

  return parsed;
}
