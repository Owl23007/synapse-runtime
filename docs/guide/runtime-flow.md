# 运行链路

## 当前消息路径

Runtime 接收 channel event，判断是否需要响应，然后补充身份、工作区和上下文，运行 Agent，经权限判断后发送回复。

```text
ChannelAdapter
  -> RuntimeCore.handleChannelEvent
  -> RuntimeCore.enrichTriggerHints(reply_to_bot)
  -> ConversationRouter.route
  -> IdentityResolver.resolve
  -> WorkspaceResolver.resolve
  -> EventProcessStore.begin
  -> TranscriptStore.append(user)
  -> ContextComposer.compose
  -> Agent.run
  -> ResponsePolicy.apply
  -> PermissionEngine.decide
  -> ChannelAdapter.sendMessage
  -> TranscriptStore.append(assistant)
  -> EventProcessStore.update(completed)
```

## 先路由，再落 transcript

群聊消息会先经过 `ConversationRouter`。未触发 bot 的群消息会被忽略，也不会写入 transcript。这样可以降低隐私风险，避免把无关群聊噪声写入上下文。

路由输出结构化 trigger 信息：

- `mentioned_bot`：明确 @ 到配置或平台识别出的 bot id。
- `mentioned_other_user`：@ 了其他用户，不触发。
- `mention_all`：@ 全体，不触发。
- `unknown_mention_ignored`：adapter 无法确认 mention 目标，默认不触发。
- `platform_at_event`：平台事件明确表示 @bot，例如 QQ Official `GROUP_AT_MESSAGE_CREATE`。
- `reply_to_bot`：`replyTo.messageId` 命中 assistant transcript 的 `externalMessageId`。
- `command_prefix`：命中命令前缀；默认不携带普通聊天历史。
- `keyword`：命中关键词。

## 上下文合成

当 `context.enabled = true` 时，Runtime 会构造确定性的 session id：

```text
platform:provider:channelId:conversationType:conversationId
```

`ContextComposer` 只读取当前 session 的最近消息，过滤 deleted rows，按字符预算裁剪旧历史，并返回包含以下 metadata 的 `PromptContext`：

- `actorId`
- `workspaceId`
- `workspaceType`
- `sessionId`
- `currentTimeIso`
- `eventReceivedAt`
- `timezone`
- `triggerKind`
- `triggerReason`
- `triggerConfidence`

历史消息进入 prompt 时会带 `createdAt` 时间前缀，并按 private/group/channel 各自的 TTL 与 maxMessages 过滤。当前用户输入保持原样，不加历史时间前缀。

## 幂等与恢复

`event_process_state` 记录每个 incoming event 的处理进度：

- `received`
- `processing`
- `agent_completed`
- `send_succeeded`
- `send_failed`
- `completed`

关键恢复行为：

- `completed` 状态下的重复事件会直接忽略。
- `send_failed` 状态下的重复事件会复用已保存的 agent output 重新发送，不再次调用 Agent。
- `send_succeeded` 但 assistant transcript 缺失时，可以补写 transcript，不重复发送。
- 新鲜的 `processing` 重复事件会按 already processing 处理。

## 安全降级

Runtime 遇到局部失败时优先降级，而不是中断整条消息链路：

- identity 解析失败时降级为 guest actor
- workspace 解析失败时降级为默认 personal/group/system workspace
- idempotency store 不可用时继续处理，但不具备恢复状态
- context compose 失败时回退为单轮请求
- response policy 失败时使用保守截断
