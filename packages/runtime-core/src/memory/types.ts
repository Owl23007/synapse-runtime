import type { WorkspaceType } from "../context/types.js";

/** 长期记忆的归属范围 */
export type MemoryScopeType = "identity" | "workspace";

/** 长期记忆的可见性 */
export type MemoryVisibility = "private" | "workspace" | "public" | "secret";

/** 长期记忆的语义类型 */
export type MemoryKind = "preference" | "fact" | "decision" | "summary";

/** 一条可持久化的长期记忆 */
export interface MemoryRecord {
  readonly id: string;
  readonly scopeType: MemoryScopeType;
  readonly scopeId: string;
  readonly identityId?: string;
  readonly workspaceId?: string;
  readonly visibility: MemoryVisibility;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly source: string;
  readonly sourceEventId?: string;
  readonly importance: number;
  readonly confidence: number;
  readonly piiLevel: "none" | "low" | "high";
  readonly promptEligible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

/** 写入长期记忆的输入 */
export interface RememberMemoryInput {
  readonly id?: string;
  readonly scopeType: MemoryScopeType;
  readonly scopeId: string;
  readonly identityId?: string;
  readonly workspaceId?: string;
  readonly visibility: MemoryVisibility;
  readonly kind?: MemoryKind;
  readonly content: string;
  readonly source: string;
  readonly sourceEventId?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly piiLevel?: "none" | "low" | "high";
  readonly promptEligible?: boolean;
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

/** 读取当前请求可见长期记忆的条件 */
export interface ListMemoryInput {
  readonly identityId: string;
  readonly workspaceId: string;
  readonly workspaceType: WorkspaceType;
  readonly includeDeleted?: boolean;
  readonly limit?: number;
}

/** 检索当前请求可见长期记忆的条件 */
export interface SearchMemoryInput extends ListMemoryInput {
  readonly query: string;
}

/** 长期记忆检索结果及其相关性分数 */
export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

/** 管理端读取长期记忆的条件 */
export interface ListAllMemoryInput {
  readonly query?: string;
  readonly scopeType?: MemoryScopeType;
  readonly scopeId?: string;
  readonly includeDeleted?: boolean;
  readonly includeSecret?: boolean;
  readonly limit?: number;
}

/** 管理端长期记忆存储能力 */
export interface MemoryAdminStore {
  /** 按管理条件读取跨身份和工作区的长期记忆 */
  listAll(input?: ListAllMemoryInput): Promise<readonly MemoryRecord[]>;
  /** 由管理端软删除长期记忆 */
  deleteByAdmin(id: string, idempotencyKey: string, deletedAt?: string): Promise<boolean>;
}

/** 删除长期记忆时用于校验访问范围的条件 */
export interface DeleteMemoryInput {
  readonly identityId: string;
  readonly workspaceId: string;
  readonly workspaceType: WorkspaceType;
  readonly idempotencyKey: string;
  readonly deletedAt?: string;
}

/** 长期记忆存储契约 */
export interface MemoryStore {
  /** 幂等写入一条长期记忆 */
  remember(input: RememberMemoryInput): Promise<MemoryRecord>;
  /** 读取当前身份和工作区可见的长期记忆 */
  list(input: ListMemoryInput): Promise<readonly MemoryRecord[]>;
  /** 在当前访问范围内按文本检索长期记忆 */
  search?(input: SearchMemoryInput): Promise<readonly MemorySearchResult[]>;
  /** 在访问范围内软删除一条长期记忆 */
  delete(id: string, input: DeleteMemoryInput): Promise<boolean>;
}
