/** 判断值是否为可深度合并的普通对象 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 按基础设施默认规则合并配置
 *
 * 对象递归合并，数组与原始值替换，undefined 不覆盖已有值，null 是显式覆盖
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override.map((item) => deepMerge(undefined, item)) as T;
  if (!isPlainObject(override)) return override as T;

  const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`Unsafe config key: ${key}`);
    result[key] = value === undefined ? result[key] : deepMerge(result[key], value);
  }
  return result as T;
}
