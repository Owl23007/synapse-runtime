#!/usr/bin/env node
import { loadConfigFile } from "./config/index.js";
import { configLoadOptions } from "./config/cli-options.js";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { parseArgs, type CliOptions } from "./cli-args.js";
import { loadEnvFile } from "@synapse/runtime-config/node";
import {
  connectProfile,
  getDefaultProfilePath,
  loadProfileConfig,
  resolveRuntimeConnection,
  useProfile
} from "@synapse/runtime-user-config";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), printHelp);

  if (options.envFile !== undefined) {
    loadEnvFile(options.envFile);
  }

  if (options.spawn || (options.command === "start" && options.positional?.[0] === "console")) {
    throw new Error("TUI 已独立，请使用 synapse-tui 启动控制台");
  }

  if (
    options.command === "status" ||
    options.command === "logs" ||
    options.command === "channels" ||
    options.command === "channel" ||
    options.command === "reload" ||
    options.command === "shutdown"
  ) {
    await runAdminCommand(options);
    return;
  }

  if (options.command === "connect" || options.command === "profiles" || options.command === "use") {
    await runProfileCommand(options);
    return;
  }

  const loadConfigOptions = configLoadOptions(options);
  const config = await loadConfigFile(options.configPath, loadConfigOptions);
  const { RuntimeServer } = await import("./server/runtime-server.js");
  const server = new RuntimeServer({ config, configPath: options.configPath, loadConfigOptions });
  // IPC 仅承担父子进程生命周期，交互仍使用带认证的 Admin API
  if (process.send && !config.admin.enabled) throw new Error("Managed Runtime requires admin.enabled=true");
  const parentDisconnected = () => {
    void server.stop().finally(() => process.exit(0));
  };
  if (process.send) process.once("disconnect", parentDisconnected);
  const started = await server.start();
  if (process.send) {
    if (!process.connected) {
      await server.stop();
      return;
    }
    process.send({ type: "synapse:runtime-ready", adminPort: started.admin?.port });
  }

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

function printHelp(): never {
  console.log(`Usage: synapse-runtime [command] [options]

Commands:
  start                 Start the runtime server. Default command
  serve                 Alias of start
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
  --workspace-config <path>  Workspace configuration overrides
  --user-config <path>  User configuration overrides
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
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
