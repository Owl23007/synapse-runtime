import type { Commit, CommitInput } from "./commit.js";
import type { Ref } from "./ref.js";
import type { ContextPath, ContextResolveOptions } from "./resolver.js";

/** 上下文图持久化契约，不依赖消息 Line 或执行生命周期 */
export interface ContextGraph {
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
  resolveContextPath(scopeId: string, name: string, options?: ContextResolveOptions): ContextPath;
}
