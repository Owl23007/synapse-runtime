const SECRET_KEY =
  /(?:authorization|cookie|password|passwd|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|^token$|^env$|^environment$)/i;

/** 在持久化前生成有界脱敏快照，避免凭据及无限对象进入追踪 */
export function redactTrace(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  let budget = 48_000;
  const scrub = (text: string): string => {
    let result = text;
    for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[=:]\s*)[^\s&"'<>]+/gi,
        "$1[REDACTED]"
      );
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 10) return "[TRUNCATED]";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "string") {
      const safe = scrub(item);
      const length = Math.min(12_000, budget);
      budget -= Math.min(safe.length, length);
      return safe.length > length ? `${safe.slice(0, length)}[TRUNCATED]` : safe;
    }
    if (typeof item !== "object") return null;
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    if (item instanceof Error) return visit({ name: item.name, message: item.message }, depth + 1);
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return "[BINARY OMITTED]";
    if (Array.isArray(item)) {
      const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
      if (item.length > 100) result.push("[TRUNCATED]");
      return result;
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, entry] of entries.slice(0, 100)) {
      const safeKey = scrub(key).slice(0, 128);
      budget -= safeKey.length;
      result[safeKey] = SECRET_KEY.test(key) ? "[REDACTED]" : visit(entry, depth + 1);
    }
    if (entries.length > 100) result._truncated = true;
    return result;
  };
  return visit(value, 0);
}
