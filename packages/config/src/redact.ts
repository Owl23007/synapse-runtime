/** 脱敏配置对象中的敏感信息，匹配敏感信息的键名模式 */
const SENSITIVE_KEY_PATTERN = /(secret|token|password|credential|privatekey|accesskey|apikey)/i;

/** 脱敏配置选项 */
export interface RedactOptions {
  /** 用于替换敏感信息的字符串，默认为 "[REDACTED]" */
  readonly replacement?: string;
}

/**
 * 脱敏配置对象中的敏感信息
 * @param value 要脱敏的配置对象
 * @param options 脱敏选项
 * @returns 脱敏后的配置对象
 */
export function redactConfig<T>(value: T, options: RedactOptions = {}): T {
  return redactValue(value, options.replacement ?? "[REDACTED]") as T;
}

/** 递归脱敏配置对象中的敏感信息 */
function redactValue(value: unknown, replacement: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, replacement));
  }

  // 递归处理对象类型的值
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? replacement : redactValue(item, replacement);
    }

    return redacted;
  }

  return value;
}
