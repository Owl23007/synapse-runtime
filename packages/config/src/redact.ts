const SENSITIVE_KEY_PATTERN = /(secret|token|password|credential|privatekey|accesskey|apikey)/i;

export interface RedactOptions {
  readonly replacement?: string;
}

export function redactConfig<T>(value: T, options: RedactOptions = {}): T {
  return redactValue(value, options.replacement ?? "[REDACTED]") as T;
}

function redactValue(value: unknown, replacement: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, replacement));
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? replacement
        : redactValue(item, replacement);
    }

    return redacted;
  }

  return value;
}
