# 当前闭环状态

更新时间：2026-08-23

## 已闭环能力

| 链路                         | 当前状态 | 代码与验证依据                                                 |
| ---------------------------- | -------- | -------------------------------------------------------------- |
| Channel 入站归一化           | 已闭环   | OneBot11、QQ Official normalizer 与脱敏 Fixture 测试           |
| 触发判定                     | 已闭环   | 私聊、群聊 mention、reply、keyword 和 unknown mention 路由测试 |
| 身份、工作区与最近上下文     | 已闭环   | `runtime-core` ContextComposer、Workspace、Transcript 测试     |
| Agent 与工具循环             | 已闭环   | OpenAI-compatible Provider、ToolRuntime、Web search/fetch 测试 |
| 发送权限与出站恢复           | 已闭环   | Permission gate、`event_process_state`、重试和崩溃恢复测试     |
| SQLite 持久化与迁移          | 已闭环   | transcript、conversation、memory 和 legacy migration 测试      |
| 配置、资源、Locale 与管理端  | 已闭环   | config、runtime resources、Admin API、CLI 测试                 |
| Channel Protocol v1 基础模型 | 已补齐   | 版本化消息、入站事件、出站动作、能力描述和标准结果模型         |
| `message.send` 运行桥接      | 已补齐   | RuntimeCore 通过统一动作执行器调用现有 Adapter                 |

## 本次对齐内容

协议层现在包含以下可序列化模型：

- `CHANNEL_PROTOCOL_SCHEMA_VERSION`
- `message.created`、`message.updated`、Reaction 和 `unknown` 事件类型
- emoji、sticker、reference、rich-content 和 unknown 消息段
- `message.send`、编辑、删除和 Reaction 出站动作
- `ChannelCapabilityProfile` 与 `ChannelActionResult`

当前 Adapter 已实际执行 `message.send`。编辑、删除和 Reaction 在能力尚未落地前会返回明确的 `unsupported`，不会静默转换成文本发送。

## 尚未闭环的明确边界

这些不是本次回归失败，而是当前产品边界：

- 模型 Presentation 仍只支持 deterministic，配置中的 `model` 会被拒绝
- `confirm`、`rate_limit` 和 `sandbox` 尚无可恢复工作流，公开配置暂时拒绝这些策略
- `web.extract` 独立工具、复杂 Citation 映射、登录态页面、浏览器和 MCP 仍未实现
- Channel Protocol 的编辑、撤回、Reaction、Sticker 出站编码尚未接入具体平台 Adapter
- Project Workspace、主动触发、Workflow 和向量检索属于后续阶段

## 验收结果

当前基线测试在本次改动前为全绿；协议桥接改动后已回归：

- `runtime-core`：14 个测试文件、101 个测试通过
- `runtime-server`：9 个测试文件、30 个测试通过
- OneBot11：8 个测试通过
- QQ Official：9 个测试通过
- protocol、channel、runtime-core 类型检查通过

完整交付前仍应执行根目录的 `pnpm test`、`pnpm typecheck`、`pnpm lint` 与 `pnpm fmt:check`
