/** 配置来源，数值越高优先级越高 */
export interface ConfigSource {
  readonly id: string;
  readonly priority: number;
  load(): Promise<Record<string, unknown>>;
}

/** 内存配置来源，可用于应用配置与测试 */
export class MemoryConfigSource implements ConfigSource {
  constructor(
    readonly id: string,
    readonly priority: number,
    private readonly value: Record<string, unknown>
  ) {}
  async load(): Promise<Record<string, unknown>> {
    return structuredClone(this.value);
  }
}

/** 从环境变量读取以双下划线分隔的模块配置，例如 SYNAPSE__editor__autosave=false */
export class EnvConfigSource implements ConfigSource {
  constructor(
    readonly id: string,
    readonly priority: number,
    private readonly prefix: string,
    private readonly env: Record<string, string | undefined> = process.env
  ) {}
  async load(): Promise<Record<string, unknown>> {
    const modules: Record<string, Record<string, unknown>> = {};
    const marker = `${this.prefix}__`;
    for (const [name, value] of Object.entries(this.env)) {
      if (value === undefined || !name.startsWith(marker)) continue;
      const [moduleId, ...path] = name.slice(marker.length).split("__");
      if (moduleId === undefined || path.length === 0) continue;
      if (
        [moduleId, ...path].some((key) => key.length === 0 || ["__proto__", "constructor", "prototype"].includes(key))
      )
        throw new Error(`Invalid environment config path: ${name}`);
      let target = (modules[moduleId] ??= {});
      for (const key of path.slice(0, -1)) {
        const existing = target[key];
        if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing)))
          throw new Error(`Conflicting environment config path: ${name}`);
        target = (target[key] ??= {}) as Record<string, unknown>;
      }
      target[path[path.length - 1]!] = coerceEnvValue(value);
    }
    return { modules };
  }
}

/** CLI 解析器生成的配置覆盖来源 */
export class CliConfigSource extends MemoryConfigSource {}

function coerceEnvValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
