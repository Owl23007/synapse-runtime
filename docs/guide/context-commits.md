# 上下文 Commit 与 Ref

DAG 表达上下文演化依赖。公共历史实体叫 `Commit`，当前状态指针叫 `Ref`，消息展示顺序继续由 Line 管理。

第一版提供 `Commit`、有序父提交、`Ref`、原子提交、Fork、显式 Merge 和有界上下文回溯。它通过 `SqliteRuntimeContextStore.dag` 使用，与其他仓储共享连接。当前 Agent Run、Task、Session 和 ContextComposer 仍使用原有链路；本版不自动把它们转换成 Commit，也不自动归属或合并语义分支。

## 写入与回流

```ts
const graph = store.dag;
const initial = graph.commit({
  scopeId: "space:project",
  refName: "session:one",
  expectedVersion: null,
  idempotencyKey: "run:first",
  type: "result",
  content: { summary: "明确需求" }
});

graph.fork("space:project", "task:search", initial.id, "task");
const result = graph.commit({
  scopeId: "space:project",
  refName: "task:search",
  expectedVersion: 1,
  idempotencyKey: "task:search:result",
  type: "task_result",
  content: { summary: "检索结果" }
});

const current = graph.getRef("space:project", "session:one")!;
graph.merge({
  scopeId: "space:project",
  refName: current.name,
  expectedVersion: current.version,
  idempotencyKey: "run:incorporate-search",
  type: "merge",
  additionalParents: [result.id],
  content: { summary: "结合当前状态和检索结果形成的新结论" }
});
```

Merge 的首父提交是目标 Ref 当前的 Commit，其他父提交是显式引入的来源。融合内容由调用方给出，不自动拼接字符串或按时间覆盖状态。Append 使用独立 Ref 上的普通提交，不立即影响主线。同一 scope 内多个 Session 可以建立不同 Ref 共享历史，跨 scope 引用会被拒绝；调用方仍负责 scope 的身份授权。

提交使用即时写事务，同时写入 Commit、父关系、幂等回执并推进 Ref。`expectedVersion: null` 只允许创建新 Ref，整数版本必须与当前 Ref 匹配。并发冲突需要重新读取当前上下文后决定如何处理，不能静默覆盖。相同幂等键和请求重试返回原 Commit，不倒退 Ref；键被用于不同请求时拒绝写入。

## 上下文读取

`resolveContextPath(scopeId, refName, { maxCommits, maxChars })` 默认最多访问 32 个不同提交，返回的完整 Commit 序列化字符数总和不超过 12000。最多允许访问 1000 个提交。广度回溯照顾多个父来源，共享祖先去重，按创建序号返回父先子后的顺序。提交只能引用更早的提交，因此无需扫描完整祖先来检查环。

超过字符预算的提交整体省略，不截断 JSON；`truncated`、`visitedCommits` 和 `usedChars` 暴露读取限制。该结果是有限的候选上下文，不是完整状态重放，也不是最终 Prompt。字符预算不等同于 Token 预算；最终 Prompt 包装、相关性筛选、摘要选择和 Token 预算留给后续 ContextComposer 接入。

## 数据库管理

`storage/sqlite/database.ts` 统一负责目录、连接、WAL、外键、锁等待、迁移失败清理与关闭。业务仓储借用连接，不自行迁移或关闭。

`runtime_migrations` 记录 `context-v7` 和 `dag-v1`。首次打开旧数据库在同一事务内执行兼容迁移并创建 DAG 表；之后启动按记录跳过已应用迁移，避免反复扫描历史消息或重建索引。旧 `user_version = 7` 保留用于旧库兼容，新模块版本由迁移记录管理；未知迁移或更高旧版本会拒绝打开，避免降级写入。

核心表为 `dag_commit`、`dag_commit_parent`、`dag_ref`，`dag_commit_request` 保存幂等回执。父关系表仅是 `parents` 数组的关系型存储，没有独立 Edge 生命周期。外键限制 Ref 指向已有同 scope 提交，触发器阻止修改和删除提交、修改父关系以及向已提交历史追加父关系。父提交必须早于子提交，保证无环。

旧 `ConversationNode` 及其表保留原有语义，尚未自动导入新图。两套数据不会双写；下一阶段接入 Run 时，需要明确历史转换和结果提交边界，避免把运行过程中的每条事件都变成 Commit。
