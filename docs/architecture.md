# Synapse Runtime 架构

应用负责选择和组装能力，模块拥有自己的配置定义与文案，基础设施负责通用机制，用户配置文件只保存用户选择的数据

## 工作区边界

| 位置                          | 职责                                                     | 不应承担                              |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `apps/runtime`                | CLI、控制台、HTTP 宿主、适配器选择、部署策略、配置组合   | 可复用业务契约                        |
| `packages/config`             | 配置令牌、合并、校验流程、优先级、临时覆盖、变更事件     | RuntimeConfig、渠道清单、全局默认权限 |
| `packages/i18n`               | 命名空间、懒加载、缓存、回退、翻译、完整性检查           | 导入所有业务文案、选择部署语言        |
| `packages/user-config`        | 原始配置与 CLI profile 的读写、原子替换                  | 业务默认值、运行时临时覆盖            |
| `packages/agent-core`         | Agent、模型请求与模型提供商契约                          | HTTP 适配、默认循环                   |
| `packages/agent-loop`         | 默认模型与工具循环                                       | 特定模型服务的 HTTP 协议              |
| `packages/agent-api-provider` | OpenAI 兼容 HTTP 适配与其配置                            | Agent 循环策略                        |
| 其余业务包                    | 各自的业务实现、`config` 子入口、`i18n` 子入口、语言资源 | 应用启动入口                          |

包名与目录分开考虑：`@synapse/runtime-server` 是位于 `apps/runtime` 的应用包，不再存在 `packages/runtime-server` 源码入口

CLI 按命令加载服务端或控制台，查询帮助、管理远程连接不需要预先加载 SQLite 和 React/Ink

## 配置链路

`loadConfigFile()` 位于应用层，其来源按以下顺序覆盖：

```text
模块默认值 → applicationConfig → 主配置文件 → workspace 文件
           → user 文件 → SYNAPSE__ 环境变量 → CLI → 临时运行时覆盖
```

应用配置文件仍采用 `[agent]`、`[channels]` 等清晰的部署段；应用将这些段映射到通用来源的 `modules.<id>`，执行时再组合为已解析的 `RuntimeConfig` 视图

`ConfigManager.get(definition)` 根据令牌推导类型，直接返回已校验的内存快照。`set()` 保留文件与环境来源，验证失败不改变当前状态；`reset()` 清除临时覆盖；`inspect()` 返回来源记录。临时覆盖不会自动写回用户文件

对象深度合并，数组替换，`undefined` 忽略，`null` 显式覆盖。权限表由应用显式采用整表替换，避免仅配置少数权限时意外保留默认授权。每个来源中的资源相对路径均以该来源文件的目录解析

应用负责跨领域约束，例如 hosted 模式不得启用 OneBot11。模块通过 `config` 子入口导出 schema 和配置令牌，不依赖应用的总配置类型

## 国际化链路

各模块在 `src/i18n.ts` 声明自己的命名空间，资源位于 `src/locales/<namespace>/<locale>.json`。语言资源通过动态导入加载，应用列表位于 `apps/runtime/src/composition/locales.ts`

`I18nManager` 支持注册与卸载、并发加载去重、语言切换、类型安全的作用域翻译、插值、复数以及数字和日期格式。切换语言在资源加载完成后生效，失败保留上一语言

当前 Node 宿主使用 `i18n/node` 同步读取所选语言及英文回退资源，以匹配同步 Runtime 工厂的创建时机；不会静态导入所有语言。需要异步模块或浏览器宿主时可直接使用资源声明的动态加载器

`LocaleResolver` 是结构化错误的展示视图，缓存和翻译统一委托 `I18nManager`。默认生产翻译缺失返回 key；错误展示可使用应用提供的 `locale.message_unavailable` 文案

通用 `config`、`i18n` 入口不导入 Node 文件模块，文件适配通过 `/node` 子入口使用

## 用户数据

`~/.synapse/cli.json` 保存 CLI 连接选择，部署配置保存模块覆盖，`runtime.dataDir` 保存会话等运行数据，三者不是同一套存储

原始配置读写不会补入业务默认值。配置写入使用同目录临时文件与替换操作；profile 写入前验证引用完整性。这里不提供跨进程配置事务或远程配置中心

## 校验

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm architecture:check
pnpm config:check
pnpm i18n:check
```

`architecture:check` 使用 TypeScript AST 和工作区清单检查未声明依赖、跨包相对导入、未导出子路径、运行时依赖循环及基础设施反向依赖。`config:check` 默认验证不需要密钥的最小配置；检查具体部署文件时执行：

```bash
node apps/runtime/dist/check.js config examples/runtime.config.toml --env-file .env
```

## 与插件式 Harness 的差异

当前是显式组装的应用，并非通用插件宿主。配置与国际化支持动态注册，但这不等于业务实例已经具备统一的插件挂载、依赖等待和卸载回收协议

`runtime-core` 仍包含 SQLite 实现；会话路由与持久会话图的命名边界也值得继续收敛。相关评估与采用范围见 [DeepSeek Harness 对照评审](./monorepo-review.md)
