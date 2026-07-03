---
layout: home

hero:
  name: Synapse Runtime
  text: Agent Infra Runtime
  tagline: 面向本地优先部署的 TypeScript Runtime，统一通道接入、Agent Provider、权限、上下文合成与运维控制面。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 包结构参考
      link: /reference/packages

features:
  - title: 统一通道
    details: 将 OneBot11/NapCat 与 QQ Official 事件归一化为 SynapseChannelEvent，并通过统一 ChannelAdapter 发送回复。
  - title: Agent Provider 层
    details: 在 Agent 接口之后接入 echo、Qwen 或 OpenAI-compatible Chat Provider。
  - title: 上下文闭环
    details: 持久化最近会话、解析身份与工作区、合成 PromptContext，并恢复重复事件投递。
  - title: 权限闸门
    details: 通道发送和工具调用在产生副作用前统一经过 Permission Engine。
  - title: Runtime Server
    details: 从 TOML/YAML/JSON 配置启动 Runtime，暴露 Admin API，并通过 CLI 或 TUI 运维。
  - title: 可扩展包结构
    details: 将协议、通道、对话、Agent、配置、权限和运行时编排拆分为独立 workspace 包。
---

## 仓库能力概览

Synapse Runtime 使用 pnpm workspace 组织代码。当前实现覆盖：

- `@synapse/runtime-core`：运行时编排、上下文闭环、幂等恢复与发送策略
- `@synapse/runtime-server`：可执行 server、CLI、Admin API 与 TUI
- `@synapse/runtime-protocol`：统一消息、事件、会话与发送者契约
- Channel 抽象，以及 OneBot11/NapCat、QQ Official 适配器
- 私聊和群聊触发策略
- Agent 抽象，以及 Qwen/OpenAI-compatible Chat Provider
- 通道发送和工具调用的静态权限决策
- 本地 SQLite 上下文存储，包括 transcript、幂等状态、workspace 绑定和可选 memory schema

建议先阅读[快速开始](/guide/getting-started)，再通过[运行链路](/guide/runtime-flow)和[配置](/guide/configuration)理解消息如何穿过整个系统。
