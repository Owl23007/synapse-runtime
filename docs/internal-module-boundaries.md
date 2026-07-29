# 内部模块边界

本说明记录运行时实现的内部职责边界，公共导出仍由各包的 `src/index.ts` 维护。

## 会话存储

`ConversationStore` 是 InMemory 与 SQLite 实现共同遵守的存储契约。共享状态迁移和生命周期规则位于 `conversation/rules.ts`，状态重建与事件追踪分别位于 `conversation/state.ts` 和 `conversation/trace.ts`。

两个后端必须通过同一套契约测试。后端文件只维护各自的索引、事务和持久化细节。

SQLite 会话仓储将数据库行类型放在 `storage/sqlite/conversation-rows.ts`，结构化值编解码放在 `storage/sqlite/json-codec.ts`。这些模块属于内部实现，不加入包级公共导出。

## RuntimeCore

`RuntimeCore` 保留事件接收、Agent 执行、工具恢复和输出投递编排。无状态的消息转换位于 `runtime/message-utils.ts`，兼容存储识别位于 `runtime/store-resolution.ts`，避免核心类继续吸收纯转换逻辑。

## 组合与适配模块

`runtime-server` 内部实现必须直接依赖具体模块，不能反向导入包级 `index.ts`。

Console 响应解析位于 `console/response-parsers.ts`，Provider 协议映射位于 `protocol-mapper.ts`，Web 目标安全策略位于 `target-policy.ts`。这些模块分别隔离外部响应解析、协议转换和网络访问约束。
