# Synapse Runtime 架构

Synapse Runtime 使用 pnpm workspace 组织代码。包依赖方向应从底层契约和抽象流向上层组合层，避免上层实现反向污染底层契约。

## 包分层

1. 契约与策略包：
   - `@synapse/runtime-protocol`
   - `@synapse/runtime-permission`
   - `@synapse/runtime-config`

2. Runtime 抽象包：
   - `@synapse/runtime-conversation`
   - `@synapse/runtime-channel`
   - `@synapse/runtime-agent-core`
   - `@synapse/runtime-tool-runtime`

3. 具体适配器与 provider：
   - `@synapse/runtime-channel-qq-official`
   - `@synapse/runtime-agent-api-provider`

4. Runtime 组合层：
   - `@synapse/runtime-core`
   - `@synapse/runtime-server`

## 依赖方向

`runtime-core` 负责编排 channel 事件、conversation 路由、agent 运行、tool runtime 和发送权限判断。它只应依赖通用抽象和协议类型。

具体 channel 包负责把平台特定 payload 归一化为 `SynapseChannelEvent`。QQ 官方 payload 字段名这类平台细节应留在 channel 包或 server gateway 模块中。

`runtime-server` 是可执行的组合层，负责基于配置创建运行时实例、注册 HTTP 路由、启动 CLI 和提供 console UI。这些职责应拆分到独立内部模块中维护。

## 扩展点

新增 channel 时，应在独立包中实现 `ChannelAdapter`，补充对应 config schema，并在 `runtime-server` 的 composition 模块中接入适配器创建逻辑。

新增 agent provider 时，应实现 `ChatCompletionProvider` 或 `Agent`，补充对应 config schema，并在 `runtime-server` 的 composition 模块中接入 provider 创建逻辑。

每个包通过 `src/index.ts` 维护稳定的 public exports。内部文件可以继续调整，但导出的 API 应保持兼容。
