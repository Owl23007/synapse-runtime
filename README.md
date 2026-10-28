# Synapse Runtime

本地优先的 Agent 运行时，将通道消息、触发路由、上下文、模型与工具调用、权限检查、回复发送和 SQLite 持久化串联起来，提供独立 Runtime 服务与 TUI 管理客户端

当前处于原型阶段，已支持持久运行追踪、原生 WebUI 会话、上下文 DAG 与群聊工件链路，持续完善执行、观察、恢复和交付体验

现有群聊工件能力支持从群聊需求出发，在本地容器中生成工件并直接上传群文件，后续对话可读取历史结果。部署步骤见下文[创建部署配置](#创建部署配置)与 `examples/group-artifacts.config.toml`；版本阶段见[通往 1.0 的路线图](docs/roadmap.md)

## 开始使用

使用 Node.js 24 与 pnpm 9.15.0，在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm verify
node apps/runtime/dist/cli.js start --config examples/minimal.config.toml
```

最小配置使用 echo Agent，无需模型密钥，也不连接真实频道。启动后可在另一个终端执行 `pnpm tui` 连接默认本地 Admin API；按 Ctrl+C 停止服务。真实消息接入请按下文[创建部署配置](#创建部署配置)操作，并填写相应频道凭据

### 使用 WebUI

构建并启动 Runtime 后，打开管理地址（默认 `http://127.0.0.1:3766`），使用配置中的 Admin Token 连接。令牌仅保留在页面内存中

- 在「会话工作台」创建本地会话，发送消息调用当前配置的 Agent，无需接入 QQ
- 在「上下文 DAG」选择历史节点，查看关联运行，创建分支后继续对话
- 在分支中「比较与合并」，确认后将结构化结果发布到主线；并发修改会提示刷新
- 在「工件」下载生成文件，在「系统状态」管理频道、取消活动任务或重载配置

最小配置使用 echo Agent；执行模型与容器工具需在 Runtime 配置中启用对应能力及权限。开发界面可执行 `pnpm webui:dev`；浏览器验收使用 `pnpm test:webui` 与 `pnpm test:workspace`，需先构建

### 创建部署配置

在仓库根目录复制配置、资源和环境变量模板，资源目录须与复制后的配置文件保持同级：

```bash
cp examples/runtime.config.toml runtime.config.toml
mkdir -p resources
cp -R examples/resources/. resources/
cp .env.example .env
```

编辑 `.env`，填写所选示例引用的必填变量。完整示例引用 `QWEN_API_KEY`、`QQ_BOT_APP_ID` 与 `QQ_BOT_APP_SECRET`；频道禁用时仍会校验其配置。首次启动默认仅监听本机且不启用频道，填写凭据、端点和触发条件后再将需要的频道设为 `enabled = true`。接收远程 Webhook 时须显式调整 Gateway 监听地址与访问控制。

群聊工件部署可将第一条复制命令的源文件改为 `examples/group-artifacts.config.toml`，其余资源复制步骤相同；填写 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`、`NAPCAT_WS_URL`、`NAPCAT_TOKEN` 和 `QQ_BOT_ID`，并预先构建示例指定的容器镜像。

```bash
node apps/runtime/dist/check.js config runtime.config.toml --env-file .env
pnpm start
```

配置中的资源路径相对于配置文件所在目录解析，与启动进程的工作目录无关。Prompt 的工具参数与执行步骤由实际注册的工具说明提供。

## 项目结构

| 目录           | 职责                                                      |
| -------------- | --------------------------------------------------------- |
| `apps/runtime` | 服务端 CLI、HTTP 网关、管理 API 与应用组装                |
| `apps/tui`     | 独立终端客户端与可选的本地子进程管理                      |
| `apps/webui`   | 原生会话、上下文 DAG、运行检查与系统管理工作台            |
| `packages`     | 协议、配置、国际化、通道、Agent、工具、上下文与存储等模块 |
| `examples`     | 版本化部署配置示例                                        |
| `tools`        | 架构检查与 Runtime/TUI 进程集成测试                       |
| `deploy`       | 部署辅助文件                                              |
| `docs`         | VitePress 用户手册、架构、技术参考与 PRD                  |

应用和包的依赖边界由 `pnpm architecture:check` 校验

Channel 使用原生能力全集描述消息、资源、交互和管理动作，平台 adapter 只映射其已实现的子集，后续 WebUI 等入口复用同一协议。职责、能力与限制见 [Channel 契约](docs/channel.md)

## 开发与验收

`pnpm verify` 是完整验收入口，构建失败或任一检查失败都会停止。开发时可单独执行 `pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm lint` 和 `pnpm fmt:check`；测试中的进程集成部分依赖最新的 `dist`，应先构建

切换 Node.js 版本后先执行 `pnpm env:check`。如果 SQLite 原生模块的 ABI 不匹配，执行 `pnpm native:rebuild` 后重新验收；不要沿用其他 Node.js 主版本构建的二进制

```bash
pnpm docs:dev
pnpm config:check
pnpm i18n:check
```
