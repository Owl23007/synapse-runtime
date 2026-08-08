# 路线图

Synapse Runtime 致力于提供本地优先、可扩展的 Agent 运行时基础设施。PRD 会按生命周期从左到右流转，任务清单与 frontmatter 的状态在构建时自动汇总。

<PrdProgress />

## 状态流程

`规划中（WIP）` → `下一步计划` → `进行中` → `完成（本迭代）` → `归档`

完成的 PRD 会保留在“完成（本迭代）”中，以便在当前迭代复盘；确认无需继续维护后，再移入 `docs/prd/archive`。

## 维护方式

在 PRD 顶部使用 frontmatter 指定其阶段，并通过任务清单维护完成进度：

```yaml
---
status: in-progress
progress: 40
---
```

可用状态为 `wip`、`next`、`in-progress`、`completed` 和 `archived`。未标注状态的 PRD 默认进入“规划中（WIP）”；归档目录中的文档始终显示在“归档”。

## 近期方向

- 持续完善通道适配与消息协议能力
- 丰富 Agent Provider 与工具调用集成
- 提升运行时配置、运维与可观测性体验
- 补充开发者文档与示例
