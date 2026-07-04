# 上下文与记忆

P0 上下文闭环实现位于 `@synapse/runtime-core`。

## Identity

`IdentityResolverLite` 将平台 sender 映射为 runtime actor：

- `guest`
- `owner`
- `system`

同一平台、provider、channel 和 sender 会得到稳定 guest id：

```text
guest:<platform>:<provider>:<channelId>:<platformUserId>
```

`/whoami` 会返回当前 platform identity 和 runtime identity。

## Workspace

`WorkspaceResolverLite` 默认解析规则：

- 私聊进入 personal workspace
- 群聊/channel 消息进入 group workspace
- system 消息进入 system workspace

`/workspace info` 返回当前 workspace id、type 和 name。

`/workspace use project:*` 会返回 P0 暂不支持，因为 project workspace 不在 P0 范围内。

## Transcript

`TranscriptStore` 在事件被路由接受后保存 user 和 assistant 消息。SQLite 实现将数据写入 `conversation_messages`。

Recent history 查询行为：

- 按 `session_id` 过滤
- 过滤 `deleted_at IS NULL`
- 按 limit 读取最近消息
- 在合成 prompt 前恢复为正序

## Response Policy

`OutputPolicyResolver` 按 workspace type 选择默认策略：

| Workspace | Mode    | maxChars | Markdown | Code Block |
| --------- | ------- | -------: | -------- | ---------- |
| personal  | normal  |     4000 | yes      | yes        |
| group     | concise |      600 | no       | no         |
| system    | system  |     2000 | yes      | yes        |

`ResponsePolicy` 是规则处理，不会二次调用 LLM。它可以：

- 移除 fenced code block
- 降级 Markdown 标题、粗体、链接和表格
- 截断到 `maxChars`
- 为较长群聊回复追加展开提示

## Durable Memory 状态

SQLite schema 已包含 `memory_records`，但 Durable Memory Lite 是可选能力，默认关闭。关闭时，`/memory remember`、`/memory list` 和 `/memory delete` 会返回明确不可用响应，不会调用 Agent。
