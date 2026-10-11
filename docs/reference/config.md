# Config Schema 参考

本页总结当前应用组合的模块 schema（`apps/runtime/src/config`）。完整示例见 `examples/runtime.config.toml`。

## `runtime`

| Field      | Type                                                         | Default              |
| ---------- | ------------------------------------------------------------ | -------------------- |
| `mode`     | `local` \| `attached` \| `hosted`                            | `local`              |
| `dataDir`  | string                                                       | `~/.synapse/runtime` |
| `logLevel` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` | `info`               |

`dataDir` 支持 `~` 展开。显式相对路径会按配置文件所在目录解析。

## `server`

| Field           | Type       | Default   |
| --------------- | ---------- | --------- |
| `host`          | string     | `0.0.0.0` |
| `port`          | number     | `3000`    |
| `publicBaseUrl` | URL string | optional  |

## `admin`

| Field                    | Type     | Default            |
| ------------------------ | -------- | ------------------ |
| `enabled`                | boolean  | `true`             |
| `host`                   | string   | `127.0.0.1`        |
| `port`                   | number   | `3766`             |
| `token`                  | string   | optional           |
| `allowedOrigins`         | string[] | local origins      |
| `allowedRemoteAddresses` | string[] | loopback addresses |
| `logBufferSize`          | number   | `300`              |

## `context`

| Field                      | Type             | Default |
| -------------------------- | ---------------- | ------- |
| `enabled`                  | boolean          | `true`  |
| `maxHistoryChars`          | positive integer | `6000`  |
| `timezone`                 | string           | `UTC`   |
| `privateHistoryTtlMinutes` | positive integer | `720`   |
| `groupHistoryTtlMinutes`   | positive integer | `30`    |
| `channelHistoryTtlMinutes` | positive integer | `30`    |
| `privateMaxMessages`       | positive integer | `20`    |
| `groupMaxMessages`         | positive integer | `6`     |
| `channelMaxMessages`       | positive integer | `8`     |

## `memory`

| Field                 | Type    | Default |
| --------------------- | ------- | ------- |
| `enableDurableMemory` | boolean | `false` |

Durable Memory 默认关闭。设置为 `true` 后启用 SQLite 记忆持久化、`/memory` 管理命令与受作用域过滤的上下文召回。

## `tools.web`

| Field                 | Type     | Default              |
| --------------------- | -------- | -------------------- |
| `enabled`             | boolean  | `false`              |
| `allowedDomains`      | string[] | `[]`                 |
| `deniedDomains`       | string[] | `[]`                 |
| `allowPrivateNetwork` | boolean  | `false`              |
| `timeoutMs`           | integer  | `15000`              |
| `maxResponseBytes`    | integer  | `2000000`            |
| `maxContentChars`     | integer  | `24000`              |
| `maxRedirects`        | integer  | `5`                  |
| `cacheTtlMs`          | integer  | `300000`             |
| `userAgent`           | string   | `SynapseRuntime/0.1` |

可选的 `tools.web.search` 支持：

- `provider = "brave"`，必须配置 `apiKey`，可选配置 `baseUrl`
- `provider = "searxng"`，必须配置 `baseUrl`

`tools.web.enabled = true` 时至少注册 `web.fetch`，配置搜索提供商后同时注册 `web.search`

## `container`

容器任务与联网工具独立配置，示例见 `examples/group-artifacts.config.toml`。未知字段会被拒绝，模型不能覆盖镜像、限额或挂载参数。

| Field              | Default            | 范围或说明                                                     |
| ------------------ | ------------------ | -------------------------------------------------------------- |
| `enabled`          | `false`            | 部署者显式启用                                                 |
| `image`            | `python:3.13-slim` | 预先安装的 Linux Python 镜像，示例使用 `synapse-artifacts:0.1` |
| `timeoutMs`        | `120000`           | 1000–300000                                                    |
| `memoryMiB`        | `512`              | 64–4096                                                        |
| `workspaceMiB`     | `64`               | 16–1024，独立临时 `/work`                                      |
| `cpus`             | `1`                | 0.1–4                                                          |
| `maxConcurrent`    | `2`                | 1–8，超额返回失败                                              |
| `maxArtifacts`     | `8`                | 1–16                                                           |
| `maxArtifactBytes` | `5242880`          | 1024–10485760                                                  |
| `maxTotalBytes`    | `10485760`         | 1024–20971520，每次输入或输出分别计量                          |
| `maxLogBytes`      | `8192`             | 256–65536                                                      |
| `storageMaxBytes`  | `268435456`        | 1048576–10737418240，仅统计工件二进制                          |

配合 `container.execute` 和 `channel.qq.upload_group_file` 权限启用 `container.run` 与 `artifact.upload`。工具仅向具备上传能力的群聊开放，完整流程和恢复边界见[群聊工件助手](../guide/group-artifacts.md)。

## `agent`

| Field       | Type        | Default  |
| ----------- | ----------- | -------- |
| `default`   | provider id | optional |
| `providers` | record      | `{}`     |

`agent.systemPrompt` 已移除。稳定模型指令由 Prompt Bundle 编译为 Invocation Envelope 后传递给 Provider。

Provider types：

- `echo`
- `openai-compatible`

`openai-compatible` providers require explicit `apiKey`, `baseUrl`, and `model` fields.

通用 chat tuning 字段：

- `temperature`
- `maxTokens`
- `topP`
- `headers`
- `extraBody`

## `conversation`

| Field                          | Type             | Default                |
| ------------------------------ | ---------------- | ---------------------- |
| `privateTrigger`               | trigger policy   | `{ mode = "always" }`  |
| `groupTrigger`                 | trigger policy   | `{ mode = "mention" }` |
| `contextPolicy.includeHistory` | boolean          | `true`                 |
| `contextPolicy.maxMessages`    | positive integer | `20`                   |

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

| Field         | Type                       | Default     |
| ------------- | -------------------------- | ----------- |
| `adapter`     | `onebot11`                 | required    |
| `provider`    | string                     | `napcat`    |
| `transport`   | `websocket`                | `websocket` |
| `endpoint`    | string                     | required    |
| `accessToken` | string                     | optional    |
| `enabled`     | boolean                    | `true`      |
| `riskLevel`   | `low`, `medium`, or `high` | `high`      |

### QQ Official

| Field           | Type                       | Default   |
| --------------- | -------------------------- | --------- |
| `adapter`       | `qq-official`              | required  |
| `appId`         | string                     | required  |
| `appSecret`     | string                     | required  |
| `mode`          | `webhook`                  | `webhook` |
| `apiBaseUrl`    | URL string                 | optional  |
| `tokenEndpoint` | URL string                 | optional  |
| `webhookPath`   | string                     | optional  |
| `enabled`       | boolean                    | `false`   |
| `riskLevel`     | `low`, `medium`, or `high` | `low`     |

## `permissions`

Permission policy values：

- `allow`
- `deny`

只有已经实现的 `allow` 和 `deny` 会被配置解析器接受。需要持久化恢复的 `confirm`、`sandbox` 和 `rate_limit` 暂不公开。

默认策略包含以下 channel send actions：

- `channel.qq.send_group_message`
- `channel.qq.send_channel_message`
- `channel.qq.send_private_message`
- `channel.qq.manage_group`
- `channel.qq.send_media`
