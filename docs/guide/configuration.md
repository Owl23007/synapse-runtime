# 配置

Runtime 配置由 `@synapse/runtime-config` 加载。Loader 支持 TOML、YAML 和 JSON；仓库内的示例文件是 `examples/runtime.config.toml`。

## 顶层配置段

```toml
[runtime]
[server]
[admin]
[context]
[memory]
[agent]
[conversation.privateTrigger]
[conversation.groupTrigger]
[conversation.contextPolicy]
[channels."<channel-id>"]
[permissions]
```

## Runtime

```toml
[runtime]
mode = "local"
dataDir = "~/.synapse/runtime"
logLevel = "info"
```

- `mode`：`local`、`attached` 或 `hosted`
- `dataDir`：本地运行时数据目录，包含 `runtime-context.sqlite`。默认是用户目录下的 `~/.synapse/runtime`；`~` 会展开为当前用户目录，显式相对路径会按配置文件所在目录解析。
- `logLevel`：`trace`、`debug`、`info`、`warn`、`error` 或 `fatal`

## Context

```toml
[context]
enabled = true
maxHistoryChars = 6000
```

启用后，`runtime-server` 会在 `runtime.dataDir` 下创建 `runtime-context.sqlite`，并将其注入为 transcript store、idempotency store 和 workspace store。

## Memory

```toml
[memory]
enableDurableMemory = false
```

Durable Memory Lite 是可选能力，默认关闭。当前 schema 已存在；memory 命令在未启用时会返回明确不可用提示。

## Agent

```toml
[agent]
default = "qwen"
systemPrompt = "You are Synapse Runtime, a concise assistant in QQ conversations."

[agent.providers.qwen]
type = "qwen"
apiKey = "${QWEN_API_KEY}"
baseUrl = "${QWEN_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
model = "qwen-plus"
temperature = 0.3
```

支持的 provider 类型：

- `echo`
- `qwen`
- `openai-compatible`

OpenAI-compatible provider 可以使用已知 `base` preset，也可以显式配置 `baseUrl` 和 `model`。

## Conversation

```toml
[conversation.privateTrigger]
mode = "always"

[conversation.groupTrigger]
mode = "mention"

[conversation.contextPolicy]
includeHistory = true
maxMessages = 20
```

触发模式：

- `always`
- `mention`
- `keyword`
- `mention_or_keyword`
- `never`

## Permissions

```toml
[permissions]
"channel.qq.send_group_message" = "allow"
"channel.qq.send_channel_message" = "allow"
"channel.qq.send_private_message" = "allow"
"channel.qq.manage_group" = "allow"
"channel.qq.send_media" = "confirm"
```

权限策略：

- `allow`
- `confirm`
- `deny`
- `sandbox`
- `rate_limit`
