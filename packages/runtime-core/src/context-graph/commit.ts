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
