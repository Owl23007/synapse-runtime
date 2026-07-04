# Config Schema 参考

本页总结当前 `@synapse/runtime-config` schema。完整示例见 `examples/runtime.config.toml`。

## `runtime`

| Field | Type | Default |
| --- | --- | --- |
| `mode` | `local | attached | hosted` | `local` |
| `dataDir` | string | `~/.synapse/runtime` |
| `logLevel` | `trace | debug | info | warn | error | fatal` | `info` |

`dataDir` 支持 `~` 展开。显式相对路径会按配置文件所在目录解析。

## `server`

| Field | Type | Default |
| --- | --- | --- |
| `host` | string | `0.0.0.0` |
| `port` | number | `3000` |
| `publicBaseUrl` | URL string | optional |

## `admin`

| Field | Type | Default |
| --- | --- | --- |
| `enabled` | boolean | `true` |
| `host` | string | `127.0.0.1` |
| `port` | number | `3766` |
| `token` | string | optional |
| `allowedOrigins` | string[] | local origins |
| `allowedRemoteAddresses` | string[] | loopback addresses |
| `logBufferSize` | number | `300` |

## `context`

| Field | Type | Default |
| --- | --- | --- |
| `enabled` | boolean | `true` |
| `maxHistoryChars` | positive integer | `6000` |
| `timezone` | string | `UTC` |
| `privateHistoryTtlMinutes` | positive integer | `720` |
| `groupHistoryTtlMinutes` | positive integer | `30` |
| `channelHistoryTtlMinutes` | positive integer | `30` |
| `privateMaxMessages` | positive integer | `20` |
| `groupMaxMessages` | positive integer | `6` |
| `channelMaxMessages` | positive integer | `8` |

## `memory`

| Field | Type | Default |
| --- | --- | --- |
| `enableDurableMemory` | boolean | `false` |

## `agent`

| Field | Type | Default |
| --- | --- | --- |
| `default` | provider id | optional |
| `systemPrompt` | string | optional |
| `providers` | record | `{}` |

Provider types：

- `echo`
- `qwen`
- `openai-compatible`

通用 chat tuning 字段：

- `temperature`
- `maxTokens`
- `topP`
- `headers`
- `extraBody`

## `conversation`

| Field | Type | Default |
| --- | --- | --- |
| `privateTrigger` | trigger policy | `{ mode = "always" }` |
| `groupTrigger` | trigger policy | `{ mode = "mention" }` |
| `contextPolicy.includeHistory` | boolean | `true` |
| `contextPolicy.maxMessages` | positive integer | `20` |

Trigger policy 字段：

- `mode`：`always`、`mention`、`keyword`、`mention_or_keyword`、`never`
- `keywords`：string array
- `botUserIds`：string array
- `commandPrefixes`：string array
- `allowCommandWithoutMention`：boolean，群聊 command 是否可以在没有 @bot 时独立触发

触发原因会在 `ConversationDecision.reason`、`AgentRequest.trigger` 和 runtime trace 中输出。常见值包括 `mentioned_bot`、`mentioned_other_user`、`mention_all`、`unknown_mention_ignored`、`platform_at_event`、`reply_to_bot`、`command_prefix`、`keyword`。

## `channels`

Channel id 必须以字母或数字开头，并且只能包含字母、数字、`_` 或 `-`。

### OneBot11

| Field | Type | Default |
| --- | --- | --- |
| `adapter` | `onebot11` | required |
| `provider` | string | `napcat` |
| `transport` | `websocket | http | http-websocket` | `websocket` |
| `endpoint` | string | required |
| `accessToken` | string | optional |
| `enabled` | boolean | `true` |
| `riskLevel` | `low | medium | high` | `high` |

### QQ Official

| Field | Type | Default |
| --- | --- | --- |
| `adapter` | `qq-official` | required |
| `appId` | string | required |
| `appSecret` | string | required |
| `mode` | `webhook | websocket` | `webhook` |
| `apiBaseUrl` | URL string | optional |
| `tokenEndpoint` | URL string | optional |
| `webhookPath` | string | optional |
| `enabled` | boolean | `false` |
| `riskLevel` | `low | medium | high` | `low` |

## `permissions`

Permission policy values：

- `allow`
- `confirm`
- `deny`
- `sandbox`
- `rate_limit`

默认策略包含以下 channel send actions：

- `channel.qq.send_group_message`
- `channel.qq.send_channel_message`
- `channel.qq.send_private_message`
- `channel.qq.manage_group`
- `channel.qq.send_media`
