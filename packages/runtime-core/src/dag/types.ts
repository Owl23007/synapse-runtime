/** 已完成的上下文变化，内容必须可序列化为 JSON */
export interface Commit {
  readonly id: string;
  readonly scopeId: string;
  readonly parents: readonly string[];
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** 当前上下文指针，版本号用于防止并发覆盖和 ABA 问题 */
export interface Ref {
  readonly scopeId: string;
  readonly name: string;
  readonly type: string;
  readonly commitId: string;
  readonly version: number;
}

/** 原子提交参数，首父节点由目标 Ref 决定，其他父节点表示显式合并 */
export interface CommitInput {
  readonly scopeId: string;
  readonly refName: string;
  readonly expectedVersion: number | null;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly additionalParents?: readonly string[];
}

/** 有界回溯结果，节点按父节点先于子节点排列，截断来源明确保留 */
export interface DagContextPath {
  readonly ref: Ref;
  readonly commits: readonly Commit[];
  readonly truncated: boolean;
  readonly visitedCommits: number;
  readonly usedChars: number;
}

/** DAG 持久化契约，不依赖消息 Line 或执行生命周期 */
export interface DagStore {
  /** 读取指定作用域内的提交 */
  getCommit(scopeId: string, id: string): Commit | undefined;
  /** 读取当前 Ref */
  getRef(scopeId: string, name: string): Ref | undefined;
  /** 原子写入提交并推进 Ref */
  commit(input: CommitInput): Commit;
  /** 显式融合多个来源并推进目标 Ref */
  merge(input: CommitInput & { readonly additionalParents: readonly string[] }): Commit;
  /** 从历史提交创建独立 Ref */
  fork(scopeId: string, name: string, commitId: string, type?: string): Ref;
  /** 返回预算内可用的历史提交，不直接构造 Prompt */
  resolveContextPath(
    scopeId: string,
    name: string,
    options?: { maxCommits?: number; maxChars?: number }
  ): DagContextPath;
}
