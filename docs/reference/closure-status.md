# 当前闭环状态

更新时间：2026-09-14

本页以当前已实现的产品能力为验收范围。闭环指代码入口、处理结果、失败边界、持久化或资源回收，以及可重复执行的验证；不代表路线图中的所有规划能力已经实现

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

- 新增根 README 和 `pnpm verify` 完整验收入口，串联格式、Lint、架构、Fixture、构建（包含文档站）、类型、最小配置、国际化与全部测试
- CI 补充最小配置与国际化资源检查，避免本地脚本存在但持续集成未执行
- 热重载在释放现有资源前检查宿主字段，监听地址、管理服务开关、日志等级和缓冲容量发生变化时返回 HTTP 409，保留当前服务，详见[配置重载边界](../guide/admin-cli.md#配置重载边界)
- 路线图排除 PRD 模板，与 PRD 目录的统计口径一致

## 已有协议能力

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
- TaskRunner 提供持久任务执行与恢复机制；默认服务端尚未注册业务 executor，不能视为可创建并执行任意任务的产品入口

当前热重载不是事务式部署：通过前置检查后，如果频道连接或新资源初始化失败，不能保证自动恢复旧运行时，应修正配置后重载或重启。配置编辑只提供同进程排队与原子替换，不提供跨进程事务

## 验收结果

在 Node.js 24 与 pnpm 9.15.0 环境中执行：

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 遇到失败即停止，并在测试前构建最新产物。本次保留全部既有测试，新增 `apps/runtime/src/server/runtime-reload.test.ts` 验证 7 类宿主配置的拒绝边界、旧配置与监听器继续生效，以及后续频道重载成功

验收覆盖：

- `runtime-core`：16 个测试文件、110 个测试
- `runtime-server`：12 个测试文件、67 个测试
- OneBot11：8 个测试通过
- QQ Official：9 个测试通过
- 全部包共 261 个测试，加上 3 个真实 Runtime/TUI 进程集成测试
- 19 个应用与业务包的架构边界、6 个通道协议 Fixture、完整构建与文档站、类型、格式、Lint、最小配置和国际化检查

本次本地验证使用 Windows、Node.js 22.19.0 与 pnpm 9.15.0；CI 配置使用 Node.js 24。HTTP Webhook 到回复的测试使用外部 QQ HTTP 替身，Provider 测试也使用替身。真实 QQ 账号投递、外部模型服务与带凭据的部署仍需在目标环境联调
