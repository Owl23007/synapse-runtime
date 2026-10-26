/** 收集配置中的凭据值，使其混入自由文本时仍能被脱敏 */
export function collectTraceSecrets(value: unknown): readonly string[] {
  const secrets = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (item: unknown, sensitive = false): void => {
    if (typeof item === "string") {
      if (sensitive && item.length > 0) secrets.add(item);
      return;
    }
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const [key, entry] of Object.entries(item))
      visit(entry, sensitive || /authorization|cookie|password|secret|credential|api[_-]?key|token|headers/i.test(key));
  };
  visit(value);
  // 长凭据先替换，避免共享前缀时暴露剩余部分
  return [...secrets].sort((a, b) => b.length - a.length);
}
