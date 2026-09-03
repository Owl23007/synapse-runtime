# PRD

本目录集中维护 Synapse Runtime 的产品需求文档。当前迭代的完成进度会在[路线图](/roadmap)中自动汇总展示。

## 文档格式

进度扫描器读取 Markdown 任务列表：`- [x]` 代表已完成，`- [ ]` 代表待完成。若 PRD 暂未添加任务列表，路线图会显示“待标注”，不会推测其完成进度。

可选的 frontmatter 用于补充状态或手工进度：

```yaml
---
status: in-progress
progress: 40
---
```

`progress` 的优先级高于任务列表；`status` 支持 `wip`、`next`、`in-progress`、`completed` 和 `archived`。归档文档应移入 [`archive`](./archive/README.md)。

状态会按 `规划中（WIP）` → `下一步计划` → `进行中` → `完成（本迭代）` → `归档` 显示在路线图中。

## 进行中的 PRD

- [触发判定与时间上下文修复](./trigger-and-time-prd.md)
- [主线 / 支线会话模型](./chat-branch-prd.md)
- [Locale、Prompt Registry、上下文合成与前缀缓存重构](./locale-prompt-context-prd.md)
- [互联网访问能力](./network-reasoning-prd.md)
- [模块化重构](./package-refactor-prd.md)
- [上下文合成闭环](./loop-memory-prd.md)
- [CLI 与 Admin Console](./cli-admin-console-prd.md)
- [QQ 渠道适配](./qq-channel-prd.md)
- [Channel 输入输出调研与协议建模](./channel-input-output-protocol-prd.md)
