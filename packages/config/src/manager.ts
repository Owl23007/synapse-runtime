import type { ConfigDefinition, ConfigOverride } from "./definition.js";
import { deepMerge } from "./merge.js";
import type { ConfigSource } from "./source.js";

/** 配置变更事件，临时覆盖与持久化写入相互独立 */
export interface ConfigChangeEvent<T> {
  readonly definition: ConfigDefinition<T>;
  readonly previous: T;
  readonly next: T;
  readonly source: string;
}

/** 最终配置与参与合并的来源快照 */
export interface ConfigInspection<T> {
  readonly resolved: T;
  readonly sources: readonly { readonly source: string; readonly value: unknown }[];
}

/** 配置解析错误，保留模块、来源、路径与原始原因 */
export class ConfigResolutionError extends Error {
  constructor(
    readonly moduleId: string,
    readonly source: string,
    readonly path: string,
    cause: unknown
  ) {
    super(
      `Invalid config: module=${moduleId}, source=${source}, path=${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "ConfigResolutionError";
  }
}

type Snapshot = { source: string; priority: number; value: Record<string, unknown> };
type ErasedDefinition = ConfigDefinition<unknown>;

/** 管理模块令牌、来源优先级及原子配置更新，不读取业务定义 */
export class ConfigManager {
  readonly #definitions = new Map<string, ErasedDefinition>();
  readonly #inspections = new Map<object, ConfigInspection<unknown>>();
  readonly #overrides = new Map<object, unknown>();
  readonly #listeners = new Map<object, Set<(event: ConfigChangeEvent<unknown>) => void>>();
  #snapshots: readonly Snapshot[] = [];
  #ready = false;
  #resolving = false;

  constructor(private readonly sources: readonly ConfigSource[] = []) {}

  /** 注册定义；已就绪的管理器立即使用现有来源解析动态模块 */
  register<T>(definition: ConfigDefinition<T>): void {
    this.#assertIdle();
    if (this.#definitions.has(definition.id)) throw new Error(`Config definition conflict: ${definition.id}`);
    const erased = definition as unknown as ErasedDefinition;
    const resolved = this.#ready ? this.#compute(erased, this.#snapshots) : undefined;
    this.#definitions.set(definition.id, erased);
    if (resolved !== undefined) this.#inspections.set(definition, resolved);
  }

  /** 按令牌身份卸载配置及订阅 */
  unregister<T>(definition: ConfigDefinition<T>): void {
    this.#assertIdle();
    this.#assertRegistered(definition);
    this.#definitions.delete(definition.id);
    this.#inspections.delete(definition);
    this.#overrides.delete(definition);
    this.#listeners.delete(definition);
  }

  /** 先验证全部候选配置，再发布新快照，失败时保留上一份可用状态 */
  async resolve(): Promise<void> {
    this.#assertIdle();
    this.#resolving = true;
    let updates: Map<ErasedDefinition, ConfigInspection<unknown>>;
    try {
      const snapshots = await Promise.all(
        this.sources.map(async (source) => {
          try {
            return { source: source.id, priority: source.priority, value: structuredClone(await source.load()) };
          } catch (cause) {
            throw new ConfigResolutionError("*", source.id, "<root>", cause);
          }
        })
      );
      snapshots.sort((a, b) => a.priority - b.priority);
      updates = new Map(
        [...this.#definitions.values()].map((definition) => [definition, this.#compute(definition, snapshots)])
      );
      this.#snapshots = snapshots;
      this.#ready = true;
    } finally {
      this.#resolving = false;
    }
    const previous = new Map(this.#inspections);
    for (const [definition, value] of updates) this.#inspections.set(definition, value);
    for (const [definition, value] of updates) this.#notify(definition, previous.get(definition), value, "resolve");
  }

  /** 获取已解析的内存快照，类型由模块定义推导 */
  get<T>(definition: ConfigDefinition<T>): T {
    return this.inspect(definition).resolved;
  }

  /** 合并临时覆盖，不写入来源；验证失败不会留下无效覆盖 */
  set<T>(definition: ConfigDefinition<T>, override: ConfigOverride<T>): void {
    this.#assertIdle();
    const previous = this.inspect(definition);
    const nextOverride = deepMerge(this.#overrides.get(definition) ?? {}, override);
    const erased = definition as unknown as ErasedDefinition;
    const next = this.#compute(erased, this.#snapshots, nextOverride);
    this.#overrides.set(definition, structuredClone(nextOverride));
    this.#inspections.set(definition, next);
    this.#notify(erased, previous, next, "runtime");
  }

  /** 清除临时覆盖并恢复来源解析值 */
  reset<T>(definition: ConfigDefinition<T>): void {
    this.#assertIdle();
    const previous = this.inspect(definition);
    const erased = definition as unknown as ErasedDefinition;
    const next = this.#compute(erased, this.#snapshots, undefined, false);
    this.#overrides.delete(definition);
    this.#inspections.set(definition, next);
    this.#notify(erased, previous, next, "runtime");
  }

  /** 订阅配置变更并返回取消订阅函数 */
  onChange<T>(definition: ConfigDefinition<T>, listener: (event: ConfigChangeEvent<T>) => void): () => void {
    this.#assertRegistered(definition);
    const listeners = this.#listeners.get(definition) ?? new Set();
    const erased = listener as unknown as (event: ConfigChangeEvent<unknown>) => void;
    listeners.add(erased);
    this.#listeners.set(definition, listeners);
    return () => {
      listeners.delete(erased);
    };
  }

  /** 返回不可变的配置和来源记录，展示前应按需脱敏 */
  inspect<T>(definition: ConfigDefinition<T>): ConfigInspection<T> {
    this.#assertRegistered(definition);
    const result = this.#inspections.get(definition);
    if (result === undefined) throw new Error(`Config ${definition.id} has not been resolved`);
    return result as ConfigInspection<T>;
  }

  #assertIdle(): void {
    if (this.#resolving) throw new Error("Config resolution is in progress");
  }
  #assertRegistered(definition: { id: string }): void {
    if (this.#definitions.get(definition.id) !== definition) throw new Error(`Unknown config token: ${definition.id}`);
  }
  #compute(
    definition: ErasedDefinition,
    snapshots: readonly Snapshot[],
    override = this.#overrides.get(definition),
    useOverride = true
  ): ConfigInspection<unknown> {
    let value: unknown = structuredClone(definition.defaults === undefined ? {} : definition.defaults);
    let source = "defaults";
    const sources = [{ source, value: structuredClone(value) }];
    try {
      for (const snapshot of snapshots) {
        const previousSource = source;
        source = snapshot.source;
        const modules = snapshot.value.modules;
        if (modules === undefined) {
          source = previousSource;
          continue;
        }
        if (modules === null || typeof modules !== "object" || Array.isArray(modules))
          throw new Error("modules must be an object");
        if (!Object.hasOwn(modules, definition.id)) {
          source = previousSource;
          continue;
        }
        let candidate = structuredClone((modules as Record<string, unknown>)[definition.id]);
        if (candidate === undefined) continue;
        sources.push({ source, value: structuredClone(candidate) });
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          const { $version, ...fields } = candidate as Record<string, unknown>;
          candidate = fields;
          if ($version !== undefined) {
            if (
              !Number.isInteger($version) ||
              Number($version) < 1 ||
              definition.version === undefined ||
              Number($version) > definition.version
            )
              throw new Error("Unsupported config version");
            if ($version !== definition.version) {
              if (definition.migrate === undefined) throw new Error("Missing config migration");
              candidate = definition.migrate(fields, Number($version));
            }
          }
        }
        value = definition.merge ? definition.merge(value, candidate as Partial<unknown>) : deepMerge(value, candidate);
      }
      if (useOverride && override !== undefined) {
        source = "runtime";
        value = definition.merge ? definition.merge(value, override as Partial<unknown>) : deepMerge(value, override);
        sources.push({ source, value: structuredClone(override) });
      }
      const parsed = definition.parse ? definition.parse(value) : value;
      return freeze({ resolved: definition.normalize ? definition.normalize(parsed) : parsed, sources });
    } catch (cause) {
      throw new ConfigResolutionError(definition.id, source, `modules.${definition.id}`, cause);
    }
  }
  #notify(
    definition: ErasedDefinition,
    previous: ConfigInspection<unknown> | undefined,
    next: ConfigInspection<unknown>,
    source: string
  ): void {
    if (previous === undefined || JSON.stringify(previous.resolved) === JSON.stringify(next.resolved)) return;
    for (const listener of this.#listeners.get(definition) ?? [])
      listener({ definition, previous: previous.resolved, next: next.resolved, source });
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
