import type { Commit } from "./commit.js";
import type { Ref } from "./ref.js";

/** 上下文选择预算，限制访问数量及完整提交的字符总量 */
export interface ContextResolveOptions {
  readonly maxCommits?: number;
  readonly maxChars?: number;
}

/** 沿当前 Ref 有界回溯，调用方负责提供一致的读取视图 */
export function resolveContextPath(
  ref: Ref,
  readCommit: (id: string) => Commit | undefined,
  options: ContextResolveOptions = {}
): ContextPath {
  const maxCommits = options.maxCommits ?? 32;
  const maxChars = options.maxChars ?? 12000;
  if (
    !Number.isSafeInteger(maxCommits) ||
    maxCommits < 1 ||
    maxCommits > 1000 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1
  )
    throw new Error("Invalid context graph budget");
  const queue = [ref.commitId];
  const queued = new Set(queue);
  const selected: Commit[] = [];
  let usedChars = 0;
  let truncated = false;
  let cursor = 0;
  while (cursor < queue.length && cursor < maxCommits) {
    const id = queue[cursor++]!;
    const commit = readCommit(id);
    if (!commit || commit.scopeId !== ref.scopeId)
      throw new Error("Context graph contains an invalid commit reference");
    const size = JSON.stringify(commit).length;
    if (usedChars + size <= maxChars) {
      selected.push(commit);
      usedChars += size;
    } else truncated = true;
    for (const parent of commit.parents) {
      if (queued.has(parent)) continue;
      queued.add(parent);
      queue.push(parent);
    }
  }
  truncated ||= cursor < queue.length;
  // 仅对已选择的提交排序，不为拓扑排序读取预算外的历史
  const ids = new Set(selected.map((commit) => commit.id));
  const pending = new Map(selected.map((commit) => [commit.id, commit.parents.filter((id) => ids.has(id)).length]));
  const children = new Map<string, Commit[]>();
  for (const commit of selected) {
    for (const parent of commit.parents) {
      const list = children.get(parent) ?? [];
      list.push(commit);
      children.set(parent, list);
    }
  }
  const commits = selected.filter((commit) => pending.get(commit.id) === 0);
  for (let index = 0; index < commits.length; index++) {
    for (const child of children.get(commits[index]!.id) ?? []) {
      const count = pending.get(child.id)! - 1;
      pending.set(child.id, count);
      if (count === 0) commits.push(child);
    }
  }
  if (commits.length !== selected.length) throw new Error("Context graph must be acyclic");
  return { ref, commits, truncated, visitedCommits: cursor, usedChars };
}

/** 有界回溯结果，节点按父节点先于子节点排列，截断来源明确保留 */
export interface ContextPath {
  readonly ref: Ref;
  readonly commits: readonly Commit[];
  readonly truncated: boolean;
  readonly visitedCommits: number;
  readonly usedChars: number;
}
