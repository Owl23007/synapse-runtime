import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { expandEnv, type EnvSource } from "./env.js";
import { ConfigError } from "./errors.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";

/** 加载并规范化运行时配置 */
export interface LoadConfigOptions {
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

  return parseConfigContent(content, filePath, options);
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
      `不支持的运行时配置扩展名 "${extension}". 请使用 .toml, .yaml, .yml 或 .json.`
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

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
