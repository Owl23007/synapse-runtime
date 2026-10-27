# PRD

本目录集中维护 Synapse Runtime 的产品需求文档。当前迭代的完成进度会在[路线图](/roadmap)中自动汇总展示，文档目录支持按生命周期和关键词查找。

当前计划：[0.1 正式版：可观测、可恢复的 DAG Agent Runtime](./v0.1-release-prd.md)，已完成代码审计与开发拆分，实施状态为“下一步计划”。配套[发布验收清单](../reference/v0.1-release-acceptance.md)独立维护正式发布门槛。

基础能力记录：[0.1：基于 DAG 的群聊工件助手](./v0.1-dag-artifacts-prd.md)，原范围的实现与本地验收已完成，不代表新版正式发布范围已完成。真实平台联调边界见文内记录。此前的历史 PRD 已移入 [`archive`](./archive/README.md)。

新建 PRD 前，请先阅读 [模板编写指南](./templates/index.md)，并复制对应语言的模板：

- [中文 PRD 模板](./templates/template.cn.md)
- [英文 PRD 模板](./templates/template.en.md)

新的活动 PRD 应放在本目录。完成且不再维护后，再移入 [`archive`](./archive/README.md)。

<PrdCatalog />
