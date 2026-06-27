import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { expandEnv, type EnvSource } from "./env.js";
import { ConfigError } from "./errors.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";

export interface LoadConfigOptions {
  readonly env?: EnvSource;
  readonly allowUndefinedEnv?: boolean;
}

export async function loadConfigFile(
  filePath: string,
  options: LoadConfigOptions = {}
): Promise<RuntimeConfig> {
  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(
      "CONFIG_FILE_READ_FAILED",
      `Failed to read runtime config file "${filePath}".`,
      error
    );
  }

  return parseConfigContent(content, filePath, options);
}

export function parseConfigContent(
  content: string,
  sourcePath = "runtime.config.yaml",
  options: LoadConfigOptions = {}
): RuntimeConfig {
  const raw = parseRawConfig(content, sourcePath);
  return parseConfigObject(raw, options);
}

export function parseConfigObject(
  value: unknown,
  options: LoadConfigOptions = {}
): RuntimeConfig {
  try {
    const expandOptions = {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.allowUndefinedEnv === undefined
        ? {}
        : { allowUndefined: options.allowUndefinedEnv })
    };
    const expanded = expandEnv(value, expandOptions);

    return RuntimeConfigSchema.parse(expanded);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    if (error instanceof ZodError) {
      throw new ConfigError("CONFIG_VALIDATION_FAILED", formatZodError(error), error);
    }

    throw error;
  }
}

function parseRawConfig(content: string, sourcePath: string): unknown {
  const extension = extname(sourcePath).toLowerCase();

  try {
    if (extension === ".json") {
      return JSON.parse(content) as unknown;
    }

    if (extension === ".yaml" || extension === ".yml" || extension === "") {
      return parseYaml(content) as unknown;
    }

    throw new ConfigError(
      "CONFIG_PARSE_FAILED",
      `Unsupported runtime config extension "${extension}". Use .yaml, .yml or .json.`
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(
      "CONFIG_PARSE_FAILED",
      `Failed to parse runtime config "${sourcePath}".`,
      error
    );
  }
}

function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });

  return `Invalid runtime config:\n${issues.join("\n")}`;
}
