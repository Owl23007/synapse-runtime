import type { PromptContextMessage } from "@synapse/runtime-conversation";

export function trimHistory(
  messages: readonly PromptContextMessage[],
  maxChars: number
): readonly PromptContextMessage[] {
  const result = [...messages];
  let total = result.reduce((sum, message) => sum + message.content.length, 0);

  while (result.length > 0 && total > maxChars) {
    const [removed] = result.splice(0, 1);
    total -= removed?.content.length ?? 0;
  }

  return result;
}

export function isWithinHistoryTtl(createdAt: string, referenceMs: number, ttlMinutes: number | undefined): boolean {
  if (ttlMinutes === undefined) {
    return true;
  }

  const createdAtMs = Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }

  return referenceMs - createdAtMs <= ttlMinutes * 60_000;
}
