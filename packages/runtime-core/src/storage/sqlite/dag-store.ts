import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CommitInput, DagContextPath, Commit, Ref, DagStore } from "../../dag/types.js";

interface CommitRow {
  id: string;
  scope_id: string;
  type: string;
  content: string;
  metadata: string;
  created_at: number;
  ordinal: number;
}

/** 借用运行时连接的 DAG 仓储，事务期间不执行异步工作 */
export class SqliteDagRepository implements DagStore {
  /** 连接由聚合存储负责迁移和关闭 */
  constructor(private readonly db: Database.Database) {}

  /** 读取作用域内的不可变节点 */
  getCommit(scopeId: string, id: string): Commit | undefined {
    const row = this.db.prepare("SELECT * FROM dag_commit WHERE scope_id = ? AND id = ?").get(scopeId, id) as
      | CommitRow
      | undefined;
    if (!row) return undefined;
    const parents = this.db
      .prepare("SELECT parent_id FROM dag_commit_parent WHERE commit_id = ? ORDER BY position")
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
        "SELECT scope_id AS scopeId, name, type, commit_id AS commitId, version FROM dag_ref WHERE scope_id = ? AND name = ?"
      )
      .get(scopeId, name) as Ref | undefined;
  }

  /** 创建节点并原子移动 Ref，重试不会将已推进的指针倒退 */
  commit(input: CommitInput): Commit {
    const request = canonical(input);
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare("SELECT request, commit_id FROM dag_commit_request WHERE scope_id = ? AND idempotency_key = ?")
          .get(input.scopeId, input.idempotencyKey) as { request: string; commit_id: string } | undefined;
        if (previous) {
          if (previous.request !== request) throw new Error("DAG idempotency key conflict");
          return this.getCommit(input.scopeId, previous.commit_id)!;
        }
        const ref = this.getRef(input.scopeId, input.refName);
        if ((ref?.version ?? null) !== input.expectedVersion) throw new Error("DAG ref version conflict");
        const parents = [...new Set([...(ref ? [ref.commitId] : []), ...(input.additionalParents ?? [])])];
        if (input.type === "merge" && parents.length < 2) throw new Error("DAG merge requires distinct parents");
        if (parents.length > 64) throw new Error("DAG parent limit exceeded");
        for (const id of parents) {
          if (!this.getCommit(input.scopeId, id)) throw new Error("DAG parent does not exist in scope");
        }
        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            "INSERT INTO dag_commit (id, scope_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(id, input.scopeId, input.type, canonical(input.content), canonical(input.metadata ?? {}), now);
        const insert = this.db.prepare("INSERT INTO dag_commit_parent VALUES (?, ?, ?)");
        parents.forEach((parent, position) => insert.run(id, parent, position));
        this.db
          .prepare("INSERT INTO dag_commit_request VALUES (?, ?, ?, ?)")
          .run(input.scopeId, input.idempotencyKey, request, id);
        this.db
          .prepare(`INSERT INTO dag_ref VALUES (?, ?, 'main', ?, 1, ?)
        ON CONFLICT(scope_id, name) DO UPDATE SET commit_id = excluded.commit_id, version = dag_ref.version + 1, updated_at = excluded.updated_at`)
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
          if (existing.commitId !== commitId || existing.type !== type) throw new Error("DAG ref already exists");
          return existing;
        }
        if (!this.getCommit(scopeId, commitId)) throw new Error("DAG fork source does not exist in scope");
        this.db.prepare("INSERT INTO dag_ref VALUES (?, ?, ?, ?, 1, ?)").run(scopeId, name, type, commitId, Date.now());
        return this.getRef(scopeId, name)!;
      })
      .immediate();
  }

  /** 显式合并来源节点，调用方负责给出融合后的内容 */
  merge(input: CommitInput & { readonly additionalParents: readonly string[] }): Commit {
    if (input.additionalParents.length === 0) throw new Error("DAG merge requires a source");
    return this.db
      .transaction(() => {
        if (!this.getRef(input.scopeId, input.refName)) throw new Error("DAG merge requires a target ref");
        return this.commit({ ...input, type: "merge" });
      })
      .immediate();
  }

  /** 有界广度回溯兼顾多父来源，不递归扫描全部历史或截断节点 JSON */
  resolveContextPath(
    scopeId: string,
    name: string,
    options: { maxCommits?: number; maxChars?: number } = {}
  ): DagContextPath {
    const maxCommits = options.maxCommits ?? 32;
    const maxChars = options.maxChars ?? 12000;
    if (
      !Number.isSafeInteger(maxCommits) ||
      maxCommits < 1 ||
      maxCommits > 1000 ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 1
    )
      throw new Error("Invalid DAG context budget");
    return this.db.transaction(() => {
      const ref = this.getRef(scopeId, name);
      if (!ref) throw new Error("DAG ref does not exist");
      const queue = [ref.commitId];
      const seen = new Set<string>();
      const commits: Commit[] = [];
      let usedChars = 0;
      let truncated = false;
      let cursor = 0;
      while (cursor < queue.length && seen.size < maxCommits) {
        const id = queue[cursor++]!;
        if (seen.has(id)) continue;
        seen.add(id);
        const commit = this.getCommit(scopeId, id)!;
        const size = JSON.stringify(commit).length;
        if (usedChars + size <= maxChars) {
          commits.push(commit);
          usedChars += size;
        } else truncated = true;
        for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
      }
      truncated ||= queue.slice(cursor).some((id) => !seen.has(id));
      // 创建序号严格大于所有父节点，排序无需再次遍历祖先
      const ordinal = this.db.prepare("SELECT ordinal FROM dag_commit WHERE id = ?");
      const order = new Map(commits.map((node) => [node.id, (ordinal.get(node.id) as { ordinal: number }).ordinal]));
      commits.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      return { ref, commits, truncated, visitedCommits: seen.size, usedChars };
    })();
  }
}

function canonical(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("DAG content must be JSON serializable");
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
