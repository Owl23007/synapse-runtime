/** 模块配置定义，同时作为类型安全的配置访问令牌 */
export interface ConfigDefinition<T> {
  readonly id: string;
  readonly version?: number;
  readonly defaults?: T;
  readonly parse?: (value: unknown) => T;
  readonly normalize?: (value: T) => T;
  readonly migrate?: (value: unknown, fromVersion: number) => T;
  readonly merge?: (base: T, override: Partial<T>) => T;
}

/** 从配置定义中提取最终配置类型 */
export type ConfigType<TDefinition> = TDefinition extends ConfigDefinition<infer TConfig> ? TConfig : never;

/** 递归配置覆盖，数组作为整体替换 */
export type ConfigOverride<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: ConfigOverride<T[K]> }
    : T;

/** 创建不可变的模块配置定义 */
export function defineConfig<T>(definition: ConfigDefinition<T>): ConfigDefinition<T> {
  if (definition.id.trim().length === 0) {
    throw new Error("Config definition id must not be empty.");
  }

  return Object.freeze({ ...definition });
}
