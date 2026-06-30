#!/usr/bin/env node
import { startRuntimeConsole } from "./console.js";
import { loadConfigFile, type RuntimeConfig } from "@synapse/runtime-config";
import { RuntimeAdminClient } from "./admin-client.js";
import { RuntimeServer, loadEnvFile } from "./index.js";
import {
  connectProfile,
  getDefaultProfilePath,
  loadProfileConfig,
  resolveRuntimeConnection,
  useProfile
} from "./profile-store.js";

interface CliOptions {
  readonly command: "start" | "serve" | "console" | "status" | "logs" | "channels" | "channel" | "reload" | "shutdown" | "connect" | "profiles" | "use";
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
  readonly channelAction?: "enable" | "disable";
  readonly channelId?: string;
  readonly positional?: readonly string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "console") {
    await startRuntimeConsole(options);
    return;
  }

  if (options.command === "status" || options.command === "logs" || options.command === "channels" || options.command === "channel" || options.command === "reload" || options.command === "shutdown") {
    await runAdminCommand(options);
    return;
  }

  if (options.command === "connect" || options.command === "profiles" || options.command === "use") {
    await runProfileCommand(options);
    return;
  }

  if (options.envFile !== undefined) {
    loadEnvFile(options.envFile);
  }

  const config = applyCliOverrides(await loadConfigFile(options.configPath), options);
  const server = new RuntimeServer({ config, configPath: options.configPath });
  await server.start();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}

function parseArgs(args: readonly string[]): CliOptions {
  let command: CliOptions["command"] = "start";
  let configPath = "runtime.config.toml";
  let envFile: string | undefined;
  let adminHost: string | undefined;
  let adminPort: number | undefined;
  let adminTokenEnv: string | undefined;
  let endpoint: string | undefined;
  let token: string | undefined;
  let tail: number | undefined;
  let profile: string | undefined;
  let profilePath: string | undefined;
  let channelAction: CliOptions["channelAction"];
  let channelId: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && (arg === "start" || arg === "serve" || arg === "console" || arg === "status" || arg === "logs" || arg === "channels" || arg === "channel" || arg === "reload" || arg === "shutdown" || arg === "connect" || arg === "profiles" || arg === "use")) {
      command = arg;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--config" || arg === "-c") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error(`${arg} requires a file path.`);
      }

      configPath = value;
      index += 1;
      continue;
    }

    if (arg === "--env-file") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--env-file requires a file path.");
      }

      envFile = value;
      index += 1;
      continue;
    }

    if (arg === "--admin-host") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--admin-host requires a host value.");
      }

      adminHost = value;
      index += 1;
      continue;
    }

    if (arg === "--admin-port") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--admin-port requires a port value.");
      }

      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--admin-port must be an integer between 0 and 65535.");
      }

      adminPort = port;
      index += 1;
      continue;
    }

    if (arg === "--admin-token-env") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--admin-token-env requires an environment variable name.");
      }

      adminTokenEnv = value;
      index += 1;
      continue;
    }

    if (arg === "--endpoint") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--endpoint requires a URL.");
      }

      endpoint = value;
      index += 1;
      continue;
    }

    if (arg === "--profile") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--profile requires a profile name.");
      }

      profile = value;
      index += 1;
      continue;
    }

    if (arg === "--profile-config") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--profile-config requires a file path.");
      }

      profilePath = value;
      index += 1;
      continue;
    }

    if (arg === "--token") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--token requires a token.");
      }

      token = value;
      index += 1;
      continue;
    }

    if (arg === "--tail" || arg === "--limit") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error(`${arg} requires a positive integer.`);
      }

      tail = parsePositiveInt(value, arg);
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
    ...(envFile === undefined ? {} : { envFile }),
    ...(adminHost === undefined ? {} : { adminHost }),
    ...(adminPort === undefined ? {} : { adminPort }),
    ...(adminTokenEnv === undefined ? {} : { adminTokenEnv }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(token === undefined ? {} : { token }),
    ...(tail === undefined ? {} : { tail }),
    ...(profile === undefined ? {} : { profile }),
    ...(profilePath === undefined ? {} : { profilePath }),
    ...(channelAction === undefined ? {} : { channelAction }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(positional.length === 0 ? {} : { positional })
  };
}

async function runAdminCommand(options: CliOptions): Promise<void> {
  const connection = await resolveRuntimeConnection({
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.profilePath === undefined ? {} : { profilePath: options.profilePath })
  });
  const client = new RuntimeAdminClient({
    endpoint: connection.endpoint,
    ...(connection.token === undefined ? {} : { token: connection.token })
  });
  const result = await runAdminClientCommand(client, options);

  console.log(JSON.stringify(result, null, 2));
}

function runAdminClientCommand(client: RuntimeAdminClient, options: CliOptions): Promise<unknown> {
  if (options.command === "status") {
    return client.status();
  }

  if (options.command === "channels") {
    return client.channels();
  }

  if (options.command === "channel") {
    if (options.channelAction === undefined || options.channelId === undefined) {
      throw new Error("channel command requires an action and channel id.");
    }

    return client.updateChannel(options.channelId, { enabled: options.channelAction === "enable" });
  }

  if (options.command === "reload") {
    return client.reload();
  }

  if (options.command === "shutdown") {
    return client.shutdown();
  }

  return client.logs({ limit: options.tail ?? 100 });
}

async function runProfileCommand(options: CliOptions): Promise<void> {
  const profilePath = options.profilePath ?? getDefaultProfilePath();

  if (options.command === "connect") {
    if (options.endpoint === undefined) {
      throw new Error("connect requires an endpoint, for example: synapse-runtime connect http://127.0.0.1:3766");
    }

    const next = await connectProfile({
      endpoint: options.endpoint,
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      profilePath
    });
    console.log(JSON.stringify({ ok: true, current: next.current, profilePath }, null, 2));
    return;
  }

  if (options.command === "use") {
    if (options.profile === undefined) {
      throw new Error("use requires a profile name, for example: synapse-runtime use prod");
    }

    const next = await useProfile(options.profile, profilePath);
    console.log(JSON.stringify({ ok: true, current: next.current, profilePath }, null, 2));
    return;
  }

  const config = await loadProfileConfig(profilePath);
  console.log(JSON.stringify({ ok: true, profilePath, ...config }, null, 2));
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} requires a positive integer.`);
  }

  return parsed;
}

function applyCliOverrides(config: RuntimeConfig, options: CliOptions): RuntimeConfig {
  if (options.adminHost === undefined && options.adminPort === undefined && options.adminTokenEnv === undefined) {
    return config;
  }

  const token = options.adminTokenEnv === undefined
    ? config.admin.token
    : process.env[options.adminTokenEnv];

  if (options.adminTokenEnv !== undefined && token === undefined) {
    throw new Error(`Environment variable "${options.adminTokenEnv}" is not set.`);
  }

  return {
    ...config,
    admin: {
      ...config.admin,
      ...(options.adminHost === undefined ? {} : { host: options.adminHost }),
      ...(options.adminPort === undefined ? {} : { port: options.adminPort }),
      ...(token === undefined ? {} : { token })
    }
  };
}

function printHelp(): void {
  console.log(`Usage: synapse-runtime [command] [options]

Commands:
  start                 Start the runtime server. Default command
  serve                 Alias of start
  console               Start the interactive runtime console
  status                Print Admin API runtime status as JSON
  logs                  Print Admin API buffered logs as JSON
  channels              Print Admin API channels as JSON
  channel enable <id>   Enable a configured channel through Admin API
  channel disable <id>  Disable a configured channel through Admin API
  reload                Reload runtime config through Admin API
  shutdown              Stop the runtime server through Admin API
  connect <endpoint>    Save an Admin API endpoint to a CLI profile
  profiles              Print configured CLI profiles as JSON
  use <profile>         Switch the current CLI profile

Options:
  -c, --config <path>   Runtime config file. Defaults to runtime.config.toml
  --env-file <path>     Optional .env file loaded before config expansion
  --admin-host <host>   Override admin API host
  --admin-port <port>   Override admin API port
  --admin-token-env <n> Read admin token from an environment variable
  --endpoint <url>      Admin API endpoint. Defaults to SYNAPSE_RUNTIME_URL or http://127.0.0.1:3766
  --token <token>       Admin API bearer token. Defaults to SYNAPSE_RUNTIME_TOKEN
  --profile <name>      CLI profile name for connect/status/logs/channels/use
  --profile-config <p>  CLI profile config path. Defaults to ~/.synapse/cli.json
  --tail <n>            Log entry count for logs. Defaults to 100
  -h, --help            Show this help message
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
