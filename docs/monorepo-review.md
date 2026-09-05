# Monorepo 设计评审：对照 DeepSeek Harness

评审结论：pnpm monorepo 的选择没有问题，原有问题主要是包的职责边界没有与配置归属、运行时生命周期和具体实现对应起来。增加目录层级本身不能解决这些问题

## 参考依据

对照公开仓库的 `d347e703908d0406b7a7ef80e3a0e594d86b2215` 快照，阅读架构文档以及 app-boot、agent、agent-loop、llm 的包清单，没有执行其代码或安装其依赖

- [架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/architecture.md)：Cordis 上的插件组合、作用域服务、可回收注册，以及 profile/bundle/user patch 的职责
- [启动包](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/boot/app-boot/package.json)：启动组合机制单独维护
- [Agent 契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/package.json)、[默认循环](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/package.json)、[LLM 接口](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm/package.json)：接口与实现可独立选择

本次借鉴其职责划分，不引入 Cordis，也不将“所有东西都做成插件”当成当前项目必须满足的目标

## 发现与处理

| 优先级 | 原有证据                                                      | 影响                               | 本次处理                                                                            |
| ------ | ------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| P0     | `config/src/schema` 枚举全部业务与默认权限                    | 增加模块必须修改基础设施           | schema 与令牌迁往模块，总配置与默认授权迁往应用                                     |
| P0     | `runtime-server` 同时是 CLI、HTTP、TUI、profile 存储          | 部署入口与可复用代码混淆           | 服务端与 TUI 分别进入 `apps/runtime`、`apps/tui`，HTTP/SSE 客户端与用户文件存储独立 |
| P0     | TUI 本地模式直接创建 RuntimeServer，远程配置命令仍写本机文件  | 连接方式改变操作语义，可能写错配置 | 本地启动改为独立进程，全部管理操作统一走服务端 API                                  |
| P0     | ConfigManager 草稿的 `set()` 使用空来源重新解析               | 临时修改会丢失文件与环境配置       | 保留来源快照，原子校验后更新                                                        |
| P1     | `runtime-resources/src/locales` 集中所有业务文案              | 文案归属不清，无法按模块扩展       | 13 个命名空间迁回各自模块或应用，基础设施不认识业务清单                             |
| P1     | `agent-api-provider/src/provider.ts` 同时实现 HTTP 与工具循环 | 更换循环和更换模型服务互相牵连     | 契约进入 agent-core，循环进入 agent-loop，HTTP 留在 provider                        |
| P1     | `cli.ts` 顶层静态导入服务端和控制台                           | 帮助与远程命令也加载本地运行依赖   | 按命令动态导入                                                                      |
| P1     | 通用国际化和配置入口导入 Node 文件模块                        | 浏览器宿主难以消费同一机制         | `/node` 独立子入口                                                                  |
| P1     | 仅靠文档约定包边界                                            | 后续改动容易重新制造隐式依赖       | 加入 AST 与 manifest 边界检查                                                       |

这些判断来自本仓库代码，并非由参考项目的目录形状直接推导

## 仍需明确的架构选择

1. **插件生命周期尚未统一**：当前 RuntimeFactory 显式创建服务，ConfigManager 和 I18nManager 的动态注册不能替代服务启动、依赖等待、失败回滚、订阅和连接清理。将来要求任意第三方插件热装卸时，应先建立统一的模块上下文与 effect/dispose 协议，再选择自建轻量宿主或 Cordis
2. **SQLite 仍位于 runtime-core 内部**：核心导出会加载具体存储实现。当前 CLI 通过延迟加载服务端避免影响远程管理命令；后续新增第二种存储或纯浏览器执行核心时，应将存储契约与 `storage-sqlite` 实现分包，同时迁移相关公共接口契约测试
3. **conversation 的语义跨度仍较大**：路由在 conversation 包，持久化会话图在 runtime-core。若二者开始独立演进，应采用 conversation-routing 与 session-store 等明确名称，而不是继续扩大一个含糊的 core
4. **应用组合列表属于合理的显式选择**：当前应用知道自己启用的模块是合理的。只有这些列表进入 config/i18n/core 基础设施时，才形成需要消除的反向中央注册表

因此本次交付是模块边界与启动配置基础设施重构，不宣称已经实现参考项目的完整插件平台、全量热更新或事件日志架构
