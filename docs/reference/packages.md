# 包结构

## 契约与策略层

| Package                       | 职责                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `@synapse/runtime-protocol`   | 共享消息、segment、sender、conversation 和 channel event 契约 |
| `@synapse/runtime-permission` | Permission request、decision、policy enum 和静态权限引擎      |
| `@synapse/runtime-config`     | Runtime config schema、环境变量展开、脱敏和配置文件加载       |

## Runtime 抽象层

| Package                         | 职责                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `@synapse/runtime-conversation` | 触发策略、对话路由、context policy 和 agent request 构造        |
| `@synapse/runtime-channel`      | Channel adapter 契约、target 类型、capabilities 和内存 registry |
| `@synapse/runtime-agent-core`   | Agent 接口、agent run 模型和 agent registry                     |
| `@synapse/runtime-tool-runtime` | Tool 注册、tool 权限检查和 tool 调用                            |

## 具体实现

| Package                                | 职责                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| `@synapse/runtime-channel-onebot11`    | OneBot11/NapCat adapter                                               |
| `@synapse/runtime-channel-qq-official` | QQ Official adapter                                                   |
| `@synapse/runtime-agent-api-provider`  | Qwen、OpenAI-compatible chat completion provider，以及 `ApiChatAgent` |

## 组合层

| Package                   | 职责                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@synapse/runtime-core`   | Channel event 编排、identity、workspace、transcript、context composition、idempotency、response policy 和权限门控发送 |
| `@synapse/runtime-server` | 配置驱动的可执行 server、HTTP gateway、Admin API、CLI、TUI、channel factory 和 agent factory                          |

## 依赖规则

底层契约不应依赖具体 adapter 或 server 组合逻辑。具体 adapter 负责把平台 payload 归一化为 protocol 类型，`runtime-server` 负责把实现装配起来。
