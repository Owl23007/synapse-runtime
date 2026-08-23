import type { ConversationStore } from "../conversation/store.js";
import type { TranscriptStore } from "../transcript/types.js";
import type { WorkspaceStore } from "../context/workspace.js";
import type { MemoryStore } from "../memory/types.js";
import type { IdentityStore } from "../context/identity.js";

/** 从兼容对象中识别会话存储 */
export function conversationStoreFromUnknown(value: unknown): ConversationStore | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("acceptNormalizedEvent" in value) ||
    !("ensureSession" in value) ||
    !("appendEvent" in value)
  ) {
    return undefined;
  }

  const candidate = value as {
    readonly acceptNormalizedEvent?: unknown;
    readonly ensureSession?: unknown;
    readonly appendEvent?: unknown;
  };
  return typeof candidate.acceptNormalizedEvent === "function" &&
    typeof candidate.ensureSession === "function" &&
    typeof candidate.appendEvent === "function"
    ? (value as ConversationStore)
    : undefined;
}

/** 从兼容对象中识别转录存储 */
export function transcriptStoreFromUnknown(value: unknown): TranscriptStore | undefined {
  if (typeof value !== "object" || value === null || !("append" in value) || !("listRecent" in value)) {
    return undefined;
  }

  const candidate = value as { readonly append?: unknown; readonly listRecent?: unknown };
  return typeof candidate.append === "function" && typeof candidate.listRecent === "function"
    ? (value as TranscriptStore)
    : undefined;
}

/** 从兼容对象中识别工作区存储 */
export function workspaceStoreFromUnknown(value: unknown): WorkspaceStore | undefined {
  if (typeof value !== "object" || value === null || !("resolveWorkspace" in value)) {
    return undefined;
  }

  const candidate = value as { readonly resolveWorkspace?: unknown };
  return typeof candidate.resolveWorkspace === "function" ? (value as WorkspaceStore) : undefined;
}

/** 从兼容对象中识别长期记忆存储 */
export function memoryStoreFromUnknown(value: unknown): MemoryStore | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("remember" in value) ||
    !("list" in value) ||
    !("delete" in value)
  ) {
    return undefined;
  }
  const candidate = value as { readonly remember?: unknown; readonly list?: unknown; readonly delete?: unknown };
  return typeof candidate.remember === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.delete === "function"
    ? (value as MemoryStore)
    : undefined;
}

/** 从兼容对象中识别身份存储 */
export function identityStoreFromUnknown(value: unknown): IdentityStore | undefined {
  if (typeof value !== "object" || value === null || !("resolveIdentity" in value)) return undefined;
  const candidate = value as { readonly resolveIdentity?: unknown };
  return typeof candidate.resolveIdentity === "function" ? (value as IdentityStore) : undefined;
}
