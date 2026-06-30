#!/usr/bin/env node
import { startRuntimeConsole } from "./console.js";
import { loadConfigFile, type RuntimeConfig } from "@synapse/runtime-config";
import { RuntimeAdminClient } from "./admin-client.js";
import { RuntimeServer, loadEnvFile } from "./index.js";

interface CliOptions {
  readonly command: "start" | "serve" | "console" | "status" | "logs" | "channels";
  readonly configPath: string;
  readonly envFile?: string;
  readonly adminHost?: string;
  readonly adminPort?: number;
  readonly adminTokenEnv?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly tail?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "console") {
    await startRuntimeConsole(options);
    return;
  }

  if (options.command === "status" || options.command === "logs" || options.command === "channels") {
    await runAdminCommand(options);
    return;
  }

  if (options.envFile !== undefined) {
    loadEnvFile(options.envFile);
  }

  const config = applyCliOverrides(await loadConfigFile(options.configPath), options);
  const server = new RuntimeServer({ config });
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

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && (arg === "start" || arg === "serve" || arg === "console" || arg === "status" || arg === "logs" || arg === "channels")) {
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

    throw new Error(`Unknown argument "${arg}".`);
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
    ...(tail === undefined ? {} : { tail })
  };
}

async function runAdminCommand(options: CliOptions): Promise<void> {
  const token = resolveAdminToken(options);
  const client = new RuntimeAdminClient({
    endpoint: resolveAdminEndpoint(options),
    ...(token === undefined ? {} : { token })
  });
  const result = options.command === "status"
    ? await client.status()
    : options.command === "channels"
      ? await client.channels()
      : await client.logs({ limit: options.tail ?? 100 });

  console.log(JSON.stringify(result, null, 2));
}

function resolveAdminEndpoint(options: CliOptions): string {
  return options.endpoint ?? process.env.SYNAPSE_RUNTIME_URL ?? "http://127.0.0.1:3766";
}

function resolveAdminToken(options: CliOptions): string | undefined {
  return options.token ?? process.env.SYNAPSE_RUNTIME_TOKEN;
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

Options:
  -c, --config <path>   Runtime config file. Defaults to runtime.config.toml
  --env-file <path>     Optional .env file loaded before config expansion
  --admin-host <host>   Override admin API host
  --admin-port <port>   Override admin API port
  --admin-token-env <n> Read admin token from an environment variable
  --endpoint <url>      Admin API endpoint. Defaults to SYNAPSE_RUNTIME_URL or http://127.0.0.1:3766
  --token <token>       Admin API bearer token. Defaults to SYNAPSE_RUNTIME_TOKEN
  --tail <n>            Log entry count for logs. Defaults to 100
  -h, --help            Show this help message
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
