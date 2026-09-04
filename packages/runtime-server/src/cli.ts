#!/usr/bin/env node
import { startRuntimeConsole } from "./console.js";
import { loadConfigFile, type RuntimeConfig } from "@synapse/runtime-config";
import { RuntimeAdminClient } from "./admin-client.js";
import { parseArgs, type CliOptions } from "./cli-args.js";
import { loadEnvFile } from "./env.js";
import {
  connectProfile,
  getDefaultProfilePath,
  loadProfileConfig,
  resolveRuntimeConnection,
  useProfile
} from "./profile-store.js";
import { RuntimeServer } from "./server/runtime-server.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), printHelp);

  if (options.command === "console") {
    await startRuntimeConsole(options);
    return;
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

function applyCliOverrides(config: RuntimeConfig, options: CliOptions): RuntimeConfig {
  if (options.adminHost === undefined && options.adminPort === undefined && options.adminTokenEnv === undefined) {
    return config;
  }

  const token = options.adminTokenEnv === undefined ? config.admin.token : process.env[options.adminTokenEnv];

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

function printHelp(): never {
  console.log(`Usage: synapse-runtime [command] [options]

Commands:
  start                 Start the runtime server. Default command
  serve                 Alias of start
  console               Start the interactive runtime console connected to Admin API
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
  --spawn               For console only: start a local runtime inside the TUI
  --tail <n>            Log entry count for logs. Defaults to 100
  -h, --help            Show this help message
`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
