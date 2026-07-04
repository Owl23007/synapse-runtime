import { ConfigError } from "./errors.js";

/** 环境变量来源类型 */
export type EnvSource = Record<string, string | undefined>;

/** 环境变量展开选项 */
export interface ExpandEnvOptions {
  readonly env?: EnvSource;
  readonly allowUndefined?: boolean;
}

/** 匹配环境变量的正则表达式，支持默认值语法 ${VAR_NAME:-default} */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

/** 
 * 展开环境变量
 * @param value 要展开的值，可以是字符串、数组或对象
 * @param options 展开选项
 * @returns 展开后的值
 */
export function expandEnv<T>(value: T, options: ExpandEnvOptions = {}): T {
  // 优先使用 options.env 作为环境变量来源，如果未提供，则使用 process.env
  const env = options.env ?? process.env; 

  // 1. 如果值是字符串，则展开环境变量
  if (typeof value === "string") {
    return expandEnvString(value, env, options.allowUndefined ?? false) as T;
  }

  // 2. 如果值是数组，则递归展开每个元素
  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item, options)) as T;
  }

  // 3. 如果值是对象，则递归展开每个属性
  if (value !== null && typeof value === "object") {
    const expanded: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      expanded[key] = expandEnv(item, options);
    }

    return expanded as T;
  }

  // 4. 如果值是其他类型，则直接返回
  return value;
}

/**
 * 展开环境变量字符串
 * @param value 要展开的字符串
 * @param env 环境变量来源
 * @param allowUndefined 是否允许未定义的变量
 * @returns 展开后的字符串
 */
export function expandEnvString(
  value: string,
  env: EnvSource = process.env,
  allowUndefined = false
): string {
  // 使用正则表达式匹配环境变量，并进行替换
  return value.replace(ENV_PATTERN, (match, name: string, fallback: string | undefined) => {
    const resolved = env[name]; // 尝试从环境变量中获取值

    if (resolved !== undefined && resolved !== "") {
      return resolved;
    }

    if (fallback !== undefined) {
      return fallback;
    }

    if (allowUndefined) {
      return match;
    }

    throw new ConfigError(
      "CONFIG_ENV_MISSING",
      `缺失环境变量: ${name}，请在环境变量中定义该变量或提供默认值。`
    );
  });
}
