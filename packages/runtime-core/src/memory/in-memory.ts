import { randomUUID } from "node:crypto";
import type {
  DeleteMemoryInput,
  ListAllMemoryInput,
  ListMemoryInput,
  MemoryAdminStore,
  MemoryRecord,
  MemorySearchResult,
  MemoryStore,
  RememberMemoryInput,
  SearchMemoryInput
} from "./types.js";

/** 长期记忆的内存参考实现，适用于测试与未接入 SQLite 的运行时 */
export class InMemoryMemoryStore implements MemoryStore, MemoryAdminStore {
  readonly #records = new Map<string, MemoryRecord>();
  readonly #idempotency = new Map<string, MemoryRecord>();
  readonly #deleteOperations = new Map<string, boolean>();

  async remember(input: RememberMemoryInput): Promise<MemoryRecord> {
    const existing = this.#idempotency.get(input.idempotencyKey);
    if (existing !== undefined) return clone(existing);
    validateMemoryInput(input);
    const now = input.createdAt ?? new Date().toISOString();
    const record: MemoryRecord = {
      id: input.id ?? `memory-${randomUUID()}`,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      visibility: input.visibility,
      kind: input.kind ?? "preference",
      content: input.content.trim(),
      source: input.source,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      piiLevel: input.piiLevel ?? "none",
      promptEligible: input.promptEligible ?? input.visibility !== "secret",
      createdAt: now,
      updatedAt: now
    };
    if (this.#records.has(record.id)) throw new Error(`Memory record "${record.id}" already exists.`);
    this.#records.set(record.id, record);
    this.#idempotency.set(input.idempotencyKey, record);
    return clone(record);
  }

  async list(input: ListMemoryInput): Promise<readonly MemoryRecord[]> {
    validateListInput(input);
    return [...this.#records.values()]
      .filter((record) => input.includeDeleted === true || record.deletedAt === undefined)
      .filter((record) => record.promptEligible || input.includeDeleted === true)
      .filter((record) => isVisible(record, input))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 20)
      .map(clone);
  }

  async search(input: SearchMemoryInput): Promise<readonly MemorySearchResult[]> {
    validateListInput(input);
    const terms = searchTerms(input.query);
    if (terms.length === 0) return [];
    return [...this.#records.values()]
      .filter((record) => input.includeDeleted === true || record.deletedAt === undefined)
      .filter((record) => record.promptEligible || input.includeDeleted === true)
      .filter((record) => isVisible(record, input))
      .map((record) => ({ record, score: relevanceScore(record, terms) }))
      .filter((result) => result.score > 0)
      .toSorted(
        (left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt)
      )
      .slice(0, input.limit ?? 20)
      .map((result) => ({ record: clone(result.record), score: result.score }));
  }

  async listAll(input: ListAllMemoryInput = {}): Promise<readonly MemoryRecord[]> {
    const query = input.query === undefined ? undefined : searchTerms(input.query);
    return [...this.#records.values()]
      .filter((record) => input.includeDeleted === true || record.deletedAt === undefined)
      .filter((record) => input.includeSecret === true || record.visibility !== "secret")
      .filter((record) => input.scopeType === undefined || record.scopeType === input.scopeType)
      .filter((record) => input.scopeId === undefined || record.scopeId === input.scopeId)
      .filter((record) => query === undefined || query.length === 0 || relevanceScore(record, query) > 0)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 100)
      .map(clone);
  }

  async delete(id: string, input: DeleteMemoryInput): Promise<boolean> {
    validateListInput(input);
    const previous = this.#deleteOperations.get(input.idempotencyKey);
    if (previous !== undefined) return previous;
    const record = this.#records.get(id);
    if (record === undefined || record.deletedAt !== undefined || !isVisible(record, input)) {
      this.#deleteOperations.set(input.idempotencyKey, false);
      return false;
    }
    const deletedAt = input.deletedAt ?? new Date().toISOString();
    this.#records.set(id, { ...record, deletedAt, updatedAt: deletedAt });
    this.#deleteOperations.set(input.idempotencyKey, true);
    return true;
  }

  async deleteByAdmin(id: string, idempotencyKey: string, deletedAt = new Date().toISOString()): Promise<boolean> {
    if (!idempotencyKey.trim()) throw new Error("Memory delete idempotency key must not be empty.");
    const previous = this.#deleteOperations.get(`admin:${idempotencyKey}`);
    if (previous !== undefined) return previous;
    const record = this.#records.get(id);
    if (record === undefined || record.deletedAt !== undefined) {
      this.#deleteOperations.set(`admin:${idempotencyKey}`, false);
      return false;
    }
    this.#records.set(id, { ...record, deletedAt, updatedAt: deletedAt });
    this.#deleteOperations.set(`admin:${idempotencyKey}`, true);
    return true;
  }
}

function isVisible(record: MemoryRecord, input: ListMemoryInput | DeleteMemoryInput): boolean {
  if (record.visibility === "secret") return false;
  if (record.scopeType === "identity") return record.scopeId === input.identityId && input.workspaceType !== "group";
  return record.scopeId === input.workspaceId;
}

function validateMemoryInput(input: RememberMemoryInput): void {
  if (!input.scopeId.trim() || !input.content.trim() || !input.source.trim() || !input.idempotencyKey.trim()) {
    throw new Error("Memory scope, content, source and idempotency key must not be empty.");
  }
  if (input.scopeType === "identity" && input.identityId !== input.scopeId) {
    throw new Error("Identity memory must be owned by its scope identity.");
  }
  if (input.scopeType === "workspace" && input.workspaceId !== input.scopeId) {
    throw new Error("Workspace memory must be owned by its scope workspace.");
  }
}

function validateListInput(input: ListMemoryInput | DeleteMemoryInput): void {
  if (
    !input.identityId.trim() ||
    !input.workspaceId.trim() ||
    ("idempotencyKey" in input && !input.idempotencyKey.trim())
  ) {
    throw new Error("Memory access identity and workspace must not be empty.");
  }
}

function searchTerms(query: string): readonly string[] {
  return [
    ...new Set(
      query
        .trim()
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    )
  ];
}

function relevanceScore(record: MemoryRecord, terms: readonly string[]): number {
  const content = record.content.toLocaleLowerCase();
  const matched = terms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0);
  return matched !== terms.length ? 0 : matched / terms.length + record.importance * 0.01 + record.confidence * 0.001;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
