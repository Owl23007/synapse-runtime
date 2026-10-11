# 上下文 Commit 与 Ref

`ContextGraph` 表达上下文演化依赖，DAG 是它必须满足的无环结构约束。公共历史实体叫 `Commit`，当前状态指针叫 `Ref`，消息展示顺序继续由 Line 管理。

领域模块位于 `context-graph/`：`commit.ts` 定义提交，`ref.ts` 定义指针，`store.ts` 定义 `ContextGraph` 契约，`resolver.ts` 负责与数据库无关的有界回溯和拓扑排序。SQLite 仓储在读取事务内调用解析器，保证 Ref 与历史的一致性。

数据库表和迁移标识同样采用 Context Graph 命名，本次重命名不提供旧图表的兼容迁移。

第一版提供 `Commit`、有序父提交、`Ref`、原子提交、Fork、显式 Merge 和有界上下文回溯。它通过 `SqliteRuntimeContextStore.contextGraph` 使用，与其他仓储共享连接。生产 Runtime 已接入 Run：每个请求从当前 Line Ref 派生独立 Run Ref，记录输入与工具终态，最终回复生成后显式合并到 Line Ref。并发运行按完成时的当前头合并，不覆盖其他运行的结果。

图作用域使用真实 Session，而不是可共享的 Workspace，因此不同群不会共享历史。后续模型调用读取当前 Line 的有界 DAG 结果；原始脚本和完整日志留在执行审计，不作为历史指令注入。工具副作用恢复仍以 Line 中的持久化回执为准，恢复回复时补齐尚未写入的图结果。命令回复不创建 Agent Run，嵌入式 Runtime 未注入图时保留原有行为。

## 写入与回流

```ts
const graph = store.contextGraph;
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

`resolveContextPath(scopeId, refName, { maxCommits, maxChars })` 默认最多访问 32 个不同提交，返回的完整 Commit 序列化字符数总和不超过 12000。最多允许访问 1000 个提交。广度回溯照顾多个父来源，共享祖先去重，仅对选中的提交进行拓扑排序，返回父先子后的顺序。提交只能引用更早的提交，因此无需扫描完整祖先来检查环。

超过字符预算的提交整体省略，不截断 JSON；`truncated`、`visitedCommits` 和 `usedChars` 暴露读取限制。该结果是有限的候选上下文，不是完整状态重放。生产 `RunContextGraph` 按 `context.maxHistoryChars` 限制 DAG 候选内容，并将提交 ID、父关系、类型和内容作为历史数据加入 Prompt；JSON 包装会有少量额外开销。此预算与消息历史、长期记忆各自的预算独立，不是整个 Prompt 的总上限，统一 Token 预算、相关性筛选和自动摘要属于后续工作。

## 数据库管理

`storage/sqlite/database.ts` 统一负责目录、连接、WAL、外键、锁等待、迁移失败清理与关闭。业务仓储借用连接，不自行迁移或关闭。

`runtime_migrations` 记录基础上下文版本 `context-v7` 和图模块版本 `context-graph-v1`。启动在同一事务内初始化未应用的表结构，之后按记录跳过已应用版本，避免反复扫描历史消息或重建索引。图模块使用 `context_graph_*` 表，不读取或迁移此前的 `dag_*` 表。

核心表为 `context_graph_commit`、`context_graph_commit_parent`、`context_graph_ref`，`context_graph_commit_request` 保存幂等回执。父关系表仅是 `parents` 数组的关系型存储，没有独立 Edge 生命周期。外键限制 Ref 指向已有同 scope 提交，触发器阻止修改和删除提交、修改父关系以及向已提交历史追加父关系。父提交必须早于子提交，保证无环。

旧 `ConversationNode` 及其表保留原有语义，不自动导入新图。图仅记录新 Run 的输入、工具终态与结果回流；消息顺序、发送回执和工具调用开始状态继续由 Line 管理。通用 TaskRunner 尚未迁移到图执行，0.1 的任务入口是被触发的群聊请求。
