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
  getCapabilities(): ChannelCapabilityProfile;
  sendMessage(target: ChannelActionTarget, message: SynapseMessage): Promise<ChannelOperationResult>;
  uploadGroupFile?(groupId: string, file: GroupFileUpload): Promise<ChannelOperationResult>;
  executePlatformAction?(action: PlatformAction): Promise<ChannelOperationResult>;
  onEvent(handler: ChannelEventHandler): void;
}
```

目标、动作、能力档案及回执均由 `@synapse/runtime-protocol` 定义。`@synapse/runtime-channel` 只定义 Adapter 生命周期、注册表和 `executeChannelAction()` 执行入口，不重复导出协议类型。

`getCapabilities()` 按动作标识声明 `supported`、`partially-supported`、`unsupported` 或 `unknown`，并可附带目标类型和文件大小约束。未声明、未知或未实现的能力返回 `unsupported`；平台扩展使用 `namespace:operation` 标识，不能借用标准能力授权。

操作回执使用 `succeeded`、`failed`、`unsupported`、`uncertain`。`uncertain` 表示平台可能已执行，必须先核对结果，不能自动重试。统一执行器不负责权限、幂等、持久化或恢复。详细边界与分阶段范围见 [Channel 重构](../reference/channel-refactor.md)。

Runtime 的消息发送、工件工具上传与自动群文件交付均经统一动作入口。工具上传和自动交付共享 Runtime 的持久回执仓储；重复调用或重启不会重复上传同一会话、频道、群中的同一工件。能力约束拒绝或实现缺失会明确失败，不会绕过执行器改用普通消息交付附件。

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

当前只公开已实现的 `websocket` transport；`http` 和 `http-websocket` 不会通过配置校验。

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

当前只公开已实现的 `webhook` mode；尚未启动 gateway loop 的 `websocket` mode 不会通过配置校验。

当前能力重点：

- QQ Official app credential
- 通过 `runtime-server` 注册 webhook route
- 事件校验与归一化
- 官方发送 API 集成

## 新增 Channel Adapter

新增 adapter 时，建议放在独立 package 中实现 `ChannelAdapter`，然后：

1. 在对应 channel 包的 `config` 子入口中定义 adapter config schema，并在应用层加入启用集合。
2. 在 `apps/runtime/src/composition/channel-factory.ts` 中补充创建逻辑。
3. 平台 payload 细节保留在 adapter package 内，不向 Agent 泄漏。
4. 每个 package 只从 `src/index.ts` 导出稳定 public API。
