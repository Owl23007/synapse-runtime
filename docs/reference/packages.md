# 包结构

## 契约与策略层

| Package                       | 职责                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `@synapse/runtime-protocol`   | 共享消息、segment、sender、conversation 和 channel event 契约 |
| `@synapse/runtime-permission` | Permission request、decision、policy enum 和静态权限引擎      |
| `@synapse/runtime-config`     | 通用配置令牌、来源、合并、临时覆盖与可观测性                  |

| `@synapse/runtime-i18n` | 命名空间、翻译、缓存、懒加载及完整性检查 |
| `@synapse/runtime-user-config` | 用户配置与 profile 原始数据持久化 |

## Runtime 抽象层

| Package                         | 职责                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `@synapse/runtime-conversation` | 触发策略、对话路由、context policy 和 agent request 构造        |
| `@synapse/runtime-channel`      | Channel adapter 契约、target 类型、capabilities 和内存 registry |
| `@synapse/runtime-agent-core`   | Agent 与模型调用契约、agent run 模型和 agent registry           |
| `@synapse/runtime-tool-runtime` | Tool 注册、tool 权限检查和 tool 调用                            |
| `@synapse/runtime-tool-web`     | 受权限和 SSRF 防护约束的 Web 搜索、抓取与文本提取               |

## 具体实现

| Package                                | 职责                                       |
| -------------------------------------- | ------------------------------------------ |
| `@synapse/runtime-channel-onebot11`    | OneBot11/NapCat adapter                    |
| `@synapse/runtime-channel-qq-official` | QQ Official adapter                        |
| `@synapse/runtime-agent-api-provider`  | OpenAI-compatible HTTP provider 与协议映射 |

| `@synapse/runtime-agent-loop` | 独立的 `ApiChatAgent` 默认模型与工具循环 |
| `@synapse/runtime-resources` | Prompt Bundle、Skill 和 Presentation 资源机制 |

## 组合层

| Package                   | 职责                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@synapse/runtime-core`   | Channel event 编排、identity、workspace、transcript、context composition、idempotency、response policy 和权限门控发送 |
| `@synapse/runtime-server` | 配置驱动的可执行 server、HTTP gateway、Admin API、CLI、TUI、channel factory 和 agent factory                          |

## 依赖规则

底层契约不应依赖具体 adapter 或 server 组合逻辑。具体 adapter 负责把平台 payload 归一化为 protocol 类型，`runtime-server` 负责把实现装配起来。

应用包 `@synapse/runtime-server` 位于 `apps/runtime`，其他包位于 `packages`。模块通过 `/config` 与 `/i18n` 子入口维护自有定义，基础设施不依赖这些模块
