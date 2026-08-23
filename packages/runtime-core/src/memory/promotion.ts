import { getTextContent, type SynapseMessage } from "@synapse/runtime-protocol";
import type { RuntimeActor, WorkspaceRef } from "../context/types.js";
import type { MemoryRecord, MemoryStore } from "./types.js";

/** 显式记忆晋升的输入 */
export interface ExplicitMemoryPromotionInput {
  readonly message: SynapseMessage;
  readonly actor: RuntimeActor;
  readonly workspace: WorkspaceRef;
  readonly sourceEventId: string;
}

/** 从用户明确要求记住的消息中创建长期记忆 */
export async function promoteExplicitMemory(
  store: MemoryStore | undefined,
  input: ExplicitMemoryPromotionInput
): Promise<MemoryRecord | undefined> {
  if (store === undefined) return undefined;
  const content = explicitMemoryContent(getTextContent(input.message));
  if (content === undefined) return undefined;
  const identityScope = input.workspace.type === "personal";
  const scopeId = identityScope ? input.actor.identity.id : input.workspace.id;
  return store.remember({
    scopeType: identityScope ? "identity" : "workspace",
    scopeId,
    ...(identityScope ? { identityId: input.actor.identity.id } : { workspaceId: input.workspace.id }),
    visibility: identityScope ? "private" : "workspace",
    kind: "fact",
    content,
    source: "auto:explicit-memory",
    sourceEventId: input.sourceEventId,
    importance: 0.8,
    confidence: 0.9,
    piiLevel: "none",
    idempotencyKey: `auto-memory:${input.sourceEventId}`
  });
}

function explicitMemoryContent(text: string): string | undefined {
  const match = /^(?:请)?记住(?:我说的)?[：:]?\s*(.+)$/u.exec(text.trim());
  const content = match?.[1]?.trim();
  return content === undefined || content.length === 0 || content.length > 1000 ? undefined : content;
}
