import { ConfigError } from "./errors.js";

export type EnvSource = Record<string, string | undefined>;

export interface ExpandEnvOptions {
  readonly env?: EnvSource;
  readonly allowUndefined?: boolean;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

export function expandEnv<T>(value: T, options: ExpandEnvOptions = {}): T {
  const env = options.env ?? process.env;

  if (typeof value === "string") {
    return expandEnvString(value, env, options.allowUndefined ?? false) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item, options)) as T;
  }

  if (value !== null && typeof value === "object") {
    const expanded: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      expanded[key] = expandEnv(item, options);
    }

    return expanded as T;
  }

  return value;
}

export function expandEnvString(
  value: string,
  env: EnvSource = process.env,
  allowUndefined = false
): string {
  return value.replace(ENV_PATTERN, (match, name: string, fallback: string | undefined) => {
    const resolved = env[name];

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
      `Missing environment variable "${name}" required by runtime config.`
    );
  });
}
