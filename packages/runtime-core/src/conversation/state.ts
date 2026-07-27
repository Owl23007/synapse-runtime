import type { ConversationStatePatch } from "./types.js";

/**
 * 将语义节点补丁应用到已有状态并返回新对象
 */
export function applyConversationStatePatch(
  state: Readonly<Record<string, unknown>>,
  patch: ConversationStatePatch
): Readonly<Record<string, unknown>> {
  return mergeObject(state, patch);
}

function mergeObject(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const next: Record<string, unknown> = structuredClone(current);

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }

    const currentValue = next[key];
    next[key] =
      isPlainObject(currentValue) && isPlainObject(value) ? mergeObject(currentValue, value) : structuredClone(value);
  }

  return next;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
