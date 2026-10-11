# Synapse Runtime

本地优先的 Agent 运行时，将通道消息、触发路由、上下文、模型与工具调用、权限检查、回复发送和 SQLite 持久化串联起来，提供独立 Runtime 服务与 TUI 管理客户端

0.1 定位为[基于 DAG 的群聊工件助手](docs/prd/v0.1-dag-artifacts-prd.md)：从群聊需求出发，在本地容器中生成工件并直接上传群文件，后续对话可读取历史结果。部署入口见[群聊工件指南](docs/guide/group-artifacts.md)与 `examples/group-artifacts.config.toml`

## 开始使用

使用 Node.js 24 与 pnpm 9.15.0，在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm verify
node apps/runtime/dist/cli.js start --config examples/minimal.config.toml
```

最小配置使用 echo Agent，无需模型密钥，也不连接真实频道。启动后可在另一个终端执行 `pnpm tui` 连接默认本地 Admin API；按 Ctrl+C 停止服务。真实消息接入请按[快速开始](docs/guide/getting-started.md)创建部署配置，并参考[频道指南](docs/guide/channels.md)填写相应凭据

## 项目结构

| 目录           | 职责                                                      |
| -------------- | --------------------------------------------------------- |
| `apps/runtime` | 服务端 CLI、HTTP 网关、管理 API 与应用组装                |
| `apps/tui`     | 独立终端客户端与可选的本地子进程管理                      |
| `packages`     | 协议、配置、国际化、通道、Agent、工具、上下文与存储等模块 |
| `examples`     | 版本化部署配置示例                                        |
| `fixtures`     | 脱敏的通道协议输入输出样本                                |
| `tools`        | 架构检查、Fixture 校验与 Runtime/TUI 进程集成测试         |
| `deploy`       | 部署辅助文件                                              |
| `docs`         | VitePress 用户手册、架构、技术参考与 PRD                  |

应用和包的依赖边界由 `pnpm architecture:check` 校验，详见[架构说明](docs/architecture.md)与[包职责](docs/reference/packages.md)

## 开发与验收

`pnpm verify` 是完整验收入口，构建失败或任一检查失败都会停止。开发时可单独执行 `pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm lint` 和 `pnpm fmt:check`；测试中的进程集成部分依赖最新的 `dist`，应先构建

切换 Node.js 版本后先执行 `pnpm env:check`。如果 SQLite 原生模块的 ABI 不匹配，执行 `pnpm native:rebuild` 后重新验收；不要沿用其他 Node.js 主版本构建的二进制

```bash
pnpm docs:dev
pnpm config:check
pnpm i18n:check
```

参阅[当前闭环状态](docs/reference/closure-status.md)了解已有验证与尚未实现的能力；参阅[Admin 与 CLI](docs/guide/admin-cli.md)了解配置编辑、热重载与重启边界
