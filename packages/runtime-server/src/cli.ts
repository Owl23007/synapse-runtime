#!/usr/bin/env node
import { startRuntimeServerFromConfigFile, loadEnvFile } from "./index.js";

interface CliOptions {
  readonly configPath: string;
  readonly envFile?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.envFile !== undefined) {
    loadEnvFile(options.envFile);
  }

  const server = await startRuntimeServerFromConfigFile(options.configPath);

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
  let configPath = "runtime.config.yaml";
  let envFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

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

    throw new Error(`Unknown argument "${arg}".`);
  }

  return {
    configPath,
    ...(envFile === undefined ? {} : { envFile })
  };
}

function printHelp(): void {
  console.log(`Usage: synapse-runtime [options]

Options:
  -c, --config <path>   Runtime config file. Defaults to runtime.config.yaml
  --env-file <path>     Optional .env file loaded before config expansion
  -h, --help            Show this help message
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
