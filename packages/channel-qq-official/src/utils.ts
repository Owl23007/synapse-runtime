import type { FetchInitLike, FetchLike, FetchResponseLike } from "./types.js";

export async function defaultFetch(url: string, init?: FetchInitLike): Promise<FetchResponseLike> {
  if (globalThis.fetch === undefined) {
    throw new Error("No fetch implementation is available in this runtime.");
  }

  return globalThis.fetch(url, init) as Promise<FetchResponseLike>;
}

export function repeatToLength(source: Buffer, length: number): Buffer {
  if (source.length === 0) {
    throw new Error("QQ official appSecret must not be empty.");
  }

  const result = Buffer.alloc(length);

  for (let index = 0; index < length; index += 1) {
    result[index] = source[index % source.length] ?? 0;
  }

  return result;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable response]";
  }
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    redacted[key] = /(secret|token|password|credential|privatekey|accesskey|apikey)/i.test(key)
      ? "[REDACTED]"
      : redactSensitive(item);
  }

  return redacted;
}

export type { FetchLike };
