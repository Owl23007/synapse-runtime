import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ZodError } from "zod";
import { expandEnv, type EnvSource } from "@synapse/runtime-config";
import { ConfigError } from "@synapse/runtime-config";
import { parseConfigFileContent } from "@synapse/runtime-config/node";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";
import {
  EnvConfigSource,
  MemoryConfigSource,
  STANDARD_CONFIG_SOURCE_PRIORITY,
  type ConfigSource
} from "@synapse/runtime-config";
import { createApplicationConfigManager, readApplicationConfig } from "./manager.js";

/** 加载并规范化运行时配置 */
export interface LoadConfigOptions {
  readonly frameworkConfig?: Record<string, unknown>;
  readonly workspaceConfigPath?: string;
  readonly userConfigPath?: string;
  readonly cliOverrides?: Record<string, unknown>;
  readonly env?: EnvSource;
  readonly allowUndefinedEnv?: boolean;
  readonly baseDir?: string;
}

/**
 * 从磁盘加载运行时配置文件
 *
 * @param filePath 配置文件路径
 * @param options 加载配置时使用的选项
 * @returns 解析并规范化后的运行时配置
 */
export async function loadConfigFile(filePath: string, options: LoadConfigOptions = {}): Promise<RuntimeConfig> {
  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigError("CONFIG_FILE_READ_FAILED", `打开配置文件失败 "${filePath}".`, error);
  }

  const env = options.env ?? process.env;
  const fileSource = (id: string, priority: number, path: string, initial?: string): ConfigSource => ({
    id,
    priority,
    async load() {
      const raw = expandEnv(parseRawConfig(initial ?? (await readFile(path, "utf8")), path), {
        env,
        ...(options.allowUndefinedEnv === undefined ? {} : { allowUndefined: options.allowUndefinedEnv })
      });
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Configuration must be an object");
      return { modules: normalizeSourcePaths(raw as Record<string, unknown>, dirname(resolve(path))) };
    }
  });
  const sources: ConfigSource[] = [
    new MemoryConfigSource("framework", STANDARD_CONFIG_SOURCE_PRIORITY.framework, {
      modules: options.frameworkConfig ?? {}
    }),
    fileSource("deployment", STANDARD_CONFIG_SOURCE_PRIORITY.deployment, filePath, content)
  ];
  if (options.workspaceConfigPath)
    sources.push(fileSource("workspace", STANDARD_CONFIG_SOURCE_PRIORITY.workspace, options.workspaceConfigPath));
  const userConfigPath = options.userConfigPath ?? env.SYNAPSE_USER_CONFIG;
  if (userConfigPath) sources.push(fileSource("user", STANDARD_CONFIG_SOURCE_PRIORITY.user, userConfigPath));
  sources.push(new EnvConfigSource("environment", STANDARD_CONFIG_SOURCE_PRIORITY.environment, "SYNAPSE", env));
  sources.push(
    new MemoryConfigSource("cli", STANDARD_CONFIG_SOURCE_PRIORITY.cli, { modules: options.cliOverrides ?? {} })
  );
  const manager = createApplicationConfigManager(sources);
  await manager.resolve();
  return normalizeConfigPaths(readApplicationConfig(manager), {
    ...options,
    baseDir: options.baseDir ?? dirname(resolve(filePath))
  });
}

/** 每个来源的相对路径以该文件所在目录解释，合并后不能再丢失来源语义 */
function normalizeSourcePaths(value: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const result = structuredClone(value);
  for (const [section, field] of [
    ["runtime", "dataDir"],
    ["locale", "catalogPath"],
    ["prompts", "catalogPath"],
    ["presentation", "profilePath"]
  ] as const) {
    const candidate = result[section];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (typeof record[field] === "string") record[field] = resolve(baseDir, expandHomeDir(record[field].trim()));
    }
  }
  return result;
}

/**
 * 解析 TOML、YAML 或 JSON 格式的运行时配置内容，并基于来源文件位置规范化路径
 *
 * @param content 配置文件内容
 * @param sourcePath 配置来源路径，用于判断格式并解析相对路径
 * @param options 解析配置时使用的选项
 * @returns 解析并规范化后的运行时配置
 */
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

/**
 * 校验原始运行时配置对象，展开环境变量占位符，并规范化路径字段
 *
 * @param value 原始配置对象
 * @param options 解析配置时使用的选项
 * @returns 校验并规范化后的运行时配置
 */
export function parseConfigObject(value: unknown, options: LoadConfigOptions = {}): RuntimeConfig {
  try {
    const expandOptions = {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.allowUndefinedEnv === undefined ? {} : { allowUndefined: options.allowUndefinedEnv })
    };
    const expanded = expandEnv(value, expandOptions);

    const config = RuntimeConfigSchema.parse(expanded, {
      // 保留必填字段的既有错误提示，避免依赖升级改变配置诊断契约
      error: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined)
    });
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
/** 规范化配置路径，支持 ~ 展开为用户主目录，并解析相对路径 */
function normalizeConfigPaths(config: RuntimeConfig, options: LoadConfigOptions): RuntimeConfig {
  const normalizeConfigPath = (pathValue: string, baseDir: string | undefined): string => {
    const expanded = expandHomeDir(pathValue.trim());

    if (isAbsolute(expanded)) {
      return expanded;
    }

    if (baseDir === undefined) {
      return expanded;
    }

    return resolve(baseDir, expanded);
  };
  return {
    ...config,
    runtime: {
      ...config.runtime,
      dataDir: normalizeConfigPath(config.runtime.dataDir, options.baseDir)
    },
    locale: {
      ...config.locale,
      ...(config.locale.catalogPath === undefined
        ? {}
        : { catalogPath: normalizeConfigPath(config.locale.catalogPath, options.baseDir) })
    },
    prompts: {
      ...config.prompts,
      ...(config.prompts.catalogPath === undefined
        ? {}
        : { catalogPath: normalizeConfigPath(config.prompts.catalogPath, options.baseDir) })
    },
    presentation: {
      ...config.presentation,
      ...(config.presentation.profilePath === undefined
        ? {}
        : { profilePath: normalizeConfigPath(config.presentation.profilePath, options.baseDir) })
    }
  };
}

/** 展开路径中的 ~ 为用户主目录 */
function expandHomeDir(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }

  return pathValue;
}

/** 解析原始配置内容为对象，支持 TOML、YAML 和 JSON 格式 */
function parseRawConfig(content: string, sourcePath: string): unknown {
  try {
    return parseConfigFileContent(content, sourcePath);
  } catch (error) {
    throw new ConfigError("CONFIG_PARSE_FAILED", `加载"${sourcePath}"失败.`, error);
  }
}

/** 格式化 Zod 校验错误为可读字符串 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });

  return `无效的运行时配置:\n${issues.join("\n")}`;
}
