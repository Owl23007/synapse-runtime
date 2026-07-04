import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { expandEnv, type EnvSource } from "./env.js";
import { ConfigError } from "./errors.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";

/** 加载配置选项 */
export interface LoadConfigOptions {
  readonly env?: EnvSource;
  readonly allowUndefinedEnv?: boolean;
  readonly baseDir?: string;
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
  sourcePath = "runtime.config.toml",
  options: LoadConfigOptions = {}
): RuntimeConfig {
  const raw = parseRawConfig(content, sourcePath);
  return parseConfigObject(raw, {
    ...options,
    baseDir: options.baseDir ?? dirname(resolve(sourcePath))
  });
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

    const config = RuntimeConfigSchema.parse(expanded);
    return normalizeConfigPaths(config, options);
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

function normalizeConfigPaths(config: RuntimeConfig, options: LoadConfigOptions): RuntimeConfig {
  return {
    ...config,
    runtime: {
      ...config.runtime,
      dataDir: normalizeConfigPath(config.runtime.dataDir, options.baseDir)
    }
  };
}

function normalizeConfigPath(pathValue: string, baseDir: string | undefined): string {
  const expanded = expandHomeDir(pathValue);

  if (isAbsolute(expanded)) {
    return expanded;
  }

  if (baseDir === undefined) {
    return expanded;
  }

  return resolve(baseDir, expanded);
}

function expandHomeDir(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }

  return pathValue;
}

function parseRawConfig(content: string, sourcePath: string): unknown {
  const extension = extname(sourcePath).toLowerCase();

  try {
    if (extension === ".json") {
      return JSON.parse(content) as unknown;
    }

    if (extension === ".toml" || extension === "") {
      return parseToml(content) as unknown;
    }

    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(content) as unknown;
    }

    throw new ConfigError(
      "CONFIG_PARSE_FAILED",
      `Unsupported runtime config extension "${extension}". Use .toml, .yaml, .yml or .json.`
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
