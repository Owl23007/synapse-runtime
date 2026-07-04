# 通道

Channel 负责把平台相关事件转换成 `SynapseChannelEvent`，并把 `SynapseMessage` 回复发送到平台目标。

## Channel Adapter 契约

每个 adapter 都实现：

```ts
interface ChannelAdapter {
  readonly id: string;
  readonly type: string;
  readonly provider: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult>;
  onEvent(handler: ChannelEventHandler): void;
}
```

## OneBot11 / NapCat

Package：`@synapse/runtime-channel-onebot11`

配置：

```toml
[channels."qq-local"]
adapter = "onebot11"
provider = "napcat"
transport = "websocket"
endpoint = "ws://127.0.0.1:3001"
accessToken = "${NAPCAT_TOKEN:-}"
enabled = false
riskLevel = "high"
```

当前能力重点：

- 接收私聊消息
- 接收群聊消息
- 发送私聊文本消息
- 发送群聊文本消息
- 将 OneBot message segment 归一化为 Runtime message segment

## QQ Official

Package：`@synapse/runtime-channel-qq-official`

配置：

```toml
[channels."qq-official"]
adapter = "qq-official"
appId = "${QQ_BOT_APP_ID}"
appSecret = "${QQ_BOT_APP_SECRET}"
mode = "webhook"
webhookPath = "/webhooks/qq-official/qq-official"
enabled = true
riskLevel = "low"
```

当前能力重点：

- QQ Official app credential
- 通过 `runtime-server` 注册 webhook route
- 事件校验与归一化
- 官方发送 API 集成

## 新增 Channel Adapter

新增 adapter 时，建议放在独立 package 中实现 `ChannelAdapter`，然后：

1. 在 `@synapse/runtime-config` 中补充 adapter config schema。
2. 在 `packages/runtime-server/src/composition/channel-factory.ts` 中补充创建逻辑。
3. 平台 payload 细节保留在 adapter package 内，不向 Agent 泄漏。
4. 每个 package 只从 `src/index.ts` 导出稳定 public API。
