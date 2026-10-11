import { resolveContextPath } from "../../context-graph/resolver.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CommitInput,
  ContextPath,
  Commit,
  Ref,
  ContextGraph,
  ContextResolveOptions
} from "../../context-graph/index.js";

interface CommitRow {
  id: string;
  scope_id: string;
  type: string;
  content: string;
  metadata: string;
  created_at: number;
  ordinal: number;
}

/** 借用运行时连接的上下文图仓储，事务期间不执行异步工作 */
export class SqliteContextGraphRepository implements ContextGraph {
  /** 连接由聚合存储负责迁移和关闭 */
  constructor(private readonly db: Database.Database) {}

  /** 通过持久化回执定位原提交，不改变当前指针 */
  getCommitByKey(scopeId: string, idempotencyKey: string): Commit | undefined {
    const row = this.db
      .prepare("SELECT commit_id FROM context_graph_commit_request WHERE scope_id = ? AND idempotency_key = ?")
      .get(scopeId, idempotencyKey) as { commit_id: string } | undefined;
    return row === undefined ? undefined : this.getCommit(scopeId, row.commit_id);
  }

  /** 读取作用域内的不可变节点 */
  getCommit(scopeId: string, id: string): Commit | undefined {
    const row = this.db.prepare("SELECT * FROM context_graph_commit WHERE scope_id = ? AND id = ?").get(scopeId, id) as
      | CommitRow
      | undefined;
    if (!row) return undefined;
    const parents = this.db
      .prepare("SELECT parent_id FROM context_graph_commit_parent WHERE commit_id = ? ORDER BY position")
      .all(id) as { parent_id: string }[];
    return {
      id: row.id,
      scopeId: row.scope_id,
      type: row.type,
      content: JSON.parse(row.content),
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      parents: parents.map((p) => p.parent_id)
    };
  }

  /** 读取当前指针及其并发版本 */
  getRef(scopeId: string, name: string): Ref | undefined {
    return this.db
      .prepare(
        "SELECT scope_id AS scopeId, name, type, commit_id AS commitId, version FROM context_graph_ref WHERE scope_id = ? AND name = ?"
      )
      .get(scopeId, name) as Ref | undefined;
  }

  /** 创建节点并原子移动 Ref，重试不会将已推进的指针倒退 */
  commit(input: CommitInput): Commit {
    const request = canonical(input);
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare(
            "SELECT request, commit_id FROM context_graph_commit_request WHERE scope_id = ? AND idempotency_key = ?"
          )
          .get(input.scopeId, input.idempotencyKey) as { request: string; commit_id: string } | undefined;
        if (previous) {
          if (previous.request !== request) throw new Error("Context graph idempotency key conflict");
          return this.getCommit(input.scopeId, previous.commit_id)!;
        }
        const ref = this.getRef(input.scopeId, input.refName);
        if ((ref?.version ?? null) !== input.expectedVersion) throw new Error("Context graph ref version conflict");
        const parents = [...new Set([...(ref ? [ref.commitId] : []), ...(input.additionalParents ?? [])])];
        if (input.type === "merge" && parents.length < 2)
          throw new Error("Context graph merge requires distinct parents");
        if (parents.length > 64) throw new Error("Context graph parent limit exceeded");
        for (const id of parents) {
          if (!this.getCommit(input.scopeId, id)) throw new Error("Context graph parent does not exist in scope");
        }
        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            "INSERT INTO context_graph_commit (id, scope_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(id, input.scopeId, input.type, canonical(input.content), canonical(input.metadata ?? {}), now);
        const insert = this.db.prepare("INSERT INTO context_graph_commit_parent VALUES (?, ?, ?)");
        parents.forEach((parent, position) => insert.run(id, parent, position));
        this.db
          .prepare("INSERT INTO context_graph_commit_request VALUES (?, ?, ?, ?)")
          .run(input.scopeId, input.idempotencyKey, request, id);
        this.db
          .prepare(`INSERT INTO context_graph_ref VALUES (?, ?, 'main', ?, 1, ?)
        ON CONFLICT(scope_id, name) DO UPDATE SET commit_id = excluded.commit_id, version = context_graph_ref.version + 1, updated_at = excluded.updated_at`)
          .run(input.scopeId, input.refName, id, now);
        return this.getCommit(input.scopeId, id)!;
      })
      .immediate();
  }

  /** Fork 与延迟 Append 共用独立 Ref，不复制历史或移动来源指针 */
  fork(scopeId: string, name: string, commitId: string, type = "branch"): Ref {
    return this.db
      .transaction(() => {
        const existing = this.getRef(scopeId, name);
        if (existing) {
          if (existing.commitId !== commitId || existing.type !== type)
            throw new Error("Context graph ref already exists");
          return existing;
        }
        if (!this.getCommit(scopeId, commitId)) throw new Error("Context graph fork source does not exist in scope");
        this.db
          .prepare("INSERT INTO context_graph_ref VALUES (?, ?, ?, ?, 1, ?)")
          .run(scopeId, name, type, commitId, Date.now());
        return this.getRef(scopeId, name)!;
      })
      .immediate();
  }

  /** 显式合并来源节点，调用方负责给出融合后的内容 */
  merge(input: CommitInput & { readonly additionalParents: readonly string[] }): Commit {
    if (input.additionalParents.length === 0) throw new Error("Context graph merge requires a source");
    return this.db
      .transaction(() => {
        if (!this.getRef(input.scopeId, input.refName)) throw new Error("Context graph merge requires a target ref");
        return this.commit({ ...input, type: "merge" });
      })
      .immediate();
  }

  /** 有界广度回溯兼顾多父来源，不递归扫描全部历史或截断节点 JSON */
  resolveContextPath(scopeId: string, name: string, options: ContextResolveOptions = {}): ContextPath {
    return this.db.transaction(() => {
      const ref = this.getRef(scopeId, name);
      if (!ref) throw new Error("Context graph ref does not exist");
      return resolveContextPath(ref, (id) => this.getCommit(scopeId, id), options);
    })();
  }
}

function canonical(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Context graph content must be JSON serializable");
  return JSON.stringify(sortJson(JSON.parse(json)));
}

function sortJson(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(sortJson);
  if (item !== null && typeof item === "object")
    return Object.fromEntries(
      Object.entries(item)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  return item;
}
