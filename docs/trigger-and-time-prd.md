# Synapse Runtime P0.5 触发判定与时间上下文修复 PRD

## 1. 文档信息

**项目名称**：Synapse Runtime
**迭代名称**：P0.5 Trigger & Context Stability Fix
**文档版本**：v0.7 PRD Freeze
**文档类型**：研发可转 PRD
**优先级**：高
**目标状态**：可进入研发排期、拆 PR、编写测试与验收

---

## 2. 背景

当前 Synapse Runtime 已经形成基础消息处理链路：

```text
ChannelAdapter
  -> RuntimeCore
  -> ConversationRouter
  -> ContextComposer
  -> Agent
  -> ResponsePolicy
  -> ChannelAdapter.sendMessage
  -> TranscriptStore
```

但在真实群聊场景中，目前存在两个明显问题：

第一，群聊里的 `@` 触发判断过于宽松。只要消息中存在 mention，就可能被认为是在 `@ bot`，导致 `@其他人`、`@全体`、未知 mention 都可能误触发 bot。

第二，上下文合成缺少时间感和话题边界。Bot 会把最近几轮历史机械拼进 prompt，导致用户几小时后发一句 `hi`，它仍可能继续旧话题。

另外，不同平台的消息能力并不一致。OneBot11 / NapCat 能明确拿到 `self_id`、`message_id`、`reply id`，而 QQ Official 的 group / channel / private 语义不同，不能用一套逻辑强行处理。

因此，本迭代目标不是做长期记忆，而是让 Runtime 具备更稳定的基础判断能力：

```text
1. 知道什么时候该回复；
2. 知道什么时候不该回复；
3. 知道历史消息发生在什么时候；
4. 知道不同平台能力不同，要按 capability 降级。
```

---

## 3. 核心问题

### 3.1 群聊 @ 误触发

当前可能出现：

```text
@别人      -> bot 回复
@全体      -> bot 回复
未知 @     -> bot 回复
```

这会造成群聊污染，也破坏“未触发群消息不入库”的隐私边界。

### 3.2 旧话题反复续答

当前 ContextComposer 主要按最近消息数量和字符数拼接历史，但没有：

```text
1. 当前时间；
2. 历史消息时间；
3. 历史 TTL；
4. 当前消息是否真的需要依赖历史；
5. command / mention / reply / keyword 的不同上下文策略。
```

结果是模型容易把旧历史当成当前话题。

### 3.3 平台能力差异没有被显式建模

不同 adapter 的能力不同：

```text
OneBot11 / NapCat：
- 有 self_id；
- 有 message_id；
- 有 reply id；
- 可直接支持 reply_to_bot。

QQ Official Group：
- GROUP_AT_MESSAGE_CREATE 可以视为 @bot；
- GROUP_MESSAGE_CREATE 是群聊全量消息，不等价于 @bot；
- group reply_to_bot 能力文档不稳定，不应作为首版强验收。

QQ Official Channel / Guild：
- AT_MESSAGE_CREATE 属于频道 @bot 或回复 bot；
- message_reference 存在时可以支持 reply_to_bot；
- 不应和 QQ group 混用。

QQ Official C2C / DM：
- 首版归入 private conversationType。
```

---

## 4. 一句话目标

> 让 Synapse Runtime 能基于平台能力精准判断触发、正确区分当前消息与历史消息，并避免群聊误触发和旧话题自动续答。

---

## 5. 目标

### 5.1 必须实现

1. 群聊 `@其他人` 不触发 bot。
2. 群聊 `@全体` 不触发 bot。
3. 群聊 unknown mention 默认不触发。
4. `platformMentionedBot = true` 可独立触发，不依赖 mention segment。
5. OneBot11 / NapCat 可从事件 `self_id` 自动识别 bot 身份。
6. OneBot11 / NapCat 可识别 `at.qq = all`。
7. OneBot11 / NapCat 可识别 reply 消息目标。
8. QQ Official `GROUP_AT_MESSAGE_CREATE` 视为群聊 @bot。
9. QQ Official `GROUP_MESSAGE_CREATE` 不自动视为 @bot。
10. QQ Official `AT_MESSAGE_CREATE` 归入 channel / guild 语义。
11. QQ Official C2C / DM 归入 private 语义。
12. 上下文必须注入当前时间、事件时间、timezone。
13. 历史消息进入 prompt 时必须带时间信息。
14. private / group / channel 分别支持历史 TTL。
15. command trigger 默认不带普通聊天历史。
16. 当前 sourceEventId 对应的 user message 不重复进入 history。
17. context TTL 与平台 passive reply window 分离。
18. 未触发群消息不写入 transcript。
19. `externalMessageId` 与 `replyTo.messageId` 必须统一 normalize 后匹配。

### 5.2 应该实现

1. ConversationDecision 输出结构化 trigger reason。
2. Runtime trace 能说明每次触发或忽略的原因。
3. AgentRequest 携带 trigger 信息。
4. ContextComposer 根据 trigger kind 决定是否带历史。
5. private 中 command 优先于 private_always。
6. channel / guild 中 reply_to_bot 优先于 AT_MESSAGE_CREATE。
7. group command 是否可无 @ 触发由配置控制。
8. OneBot11 / NapCat reply_to_bot 首版可用。
9. QQ Official reply_to_bot 由 capability 控制，不阻塞首版。

---

## 6. 非目标

本迭代不做：

1. 长期记忆总结。
2. 向量检索。
3. 多 Agent 协作。
4. Planner。
5. 自动话题分类模型。
6. 复杂用户绑定。
7. Project Workspace 自动推断。
8. 群聊全量消息入库。
9. QQ Official Group reply_to_bot 强制支持。
10. 完整后台配置 UI。
11. command registry 级别的 history policy。
12. 新增 dm conversationType。

---

## 7. Adapter 能力矩阵

| Adapter                     | @用户                    | @全体        | bot 自身身份           | 发送消息 ID | 收到回复目标      | 平台 @bot hint          | reply_to_bot        |
| --------------------------- | ------------------------ | ------------ | ---------------------- | ----------- | ----------------- | ----------------------- | ------------------- |
| OneBot11 / NapCat           | 支持                     | 支持         | event.self_id / config | 支持        | 支持              | 不需要                  | 首版必达            |
| QQ Official Group           | 依赖事件类型             | 不明确       | AppID / config         | 支持        | 文档不稳定        | GROUP_AT_MESSAGE_CREATE | conditional         |
| QQ Official Channel / Guild | 依赖 mentions / 事件类型 | 依赖 payload | AppID / bot user       | 支持        | message_reference | AT_MESSAGE_CREATE       | 有 reference 时支持 |
| QQ Official C2C / DM        | 不适用                   | 不适用       | AppID / config         | 支持        | msg_id / event_id | direct event            | partial             |

能力原则：

1. OneBot11 / NapCat 是首版 `reply_to_bot` 的主要目标。
2. QQ Official Group 只把 `GROUP_AT_MESSAGE_CREATE` 当作 @bot 强 hint。
3. QQ Official Group 的 `GROUP_MESSAGE_CREATE` 只能作为普通群消息处理。
4. QQ Official Group 的 `reply_to_bot` 不作为首版强验收。
5. QQ Official Channel / Guild 和 Group 必须分开建模。
6. 未确认的平台能力必须 capability-gated，默认保守降级。

---

## 8. 平台语义要求

### 8.1 OneBot11 / NapCat

OneBot11 / NapCat 需要实现以下能力：

1. 从事件 `self_id` 中提取 bot 自身身份。
2. 当消息段为 `at.qq = all` 时，识别为 `mention_all`。
3. 当消息段为具体 QQ 号时，识别为 `mention_user`。
4. 当消息段缺少明确 QQ 号时，识别为 `unknown_mention`。
5. 当消息中存在 reply 段时，将 reply id 映射为 `replyTo.messageId`。
6. 发送消息成功后，将返回的 `message_id` 保存为 assistant transcript 的 `externalMessageId`。
7. 收到用户回复时，用 `replyTo.messageId` 匹配历史 assistant 消息的 `externalMessageId`，命中则触发 `reply_to_bot`。

OneBot11 / NapCat 中，bot id 的优先级为：

```text
1. event.self_id
2. channel.selfUserId
3. conversation.groupTrigger.botUserIds
4. 后续可选 get_login_info
```

如果无法确定 bot id，不能退回“任意 @ 都触发”的旧逻辑。

---

### 8.2 QQ Official Group

QQ Official Group 需要区分两个事件：

#### GROUP_AT_MESSAGE_CREATE

该事件表示群聊中用户 @bot。

处理要求：

1. 设置 `platformMentionedBot = true`。
2. 即使没有 mention segment，也应触发。
3. trigger reason 为 `platform_at_event`。
4. conversation kind 为 `group`。

#### GROUP_MESSAGE_CREATE

该事件表示群聊全量消息。

处理要求：

1. 不自动视为 @bot。
2. 不因事件类型触发。
3. 可以由 keyword 触发。
4. 可以由 command_prefix 触发。
5. 默认不写入 transcript，除非触发成功。

#### QQ Official Group reply_to_bot

首版不强制支持。

只有当真实 payload 中存在明确 reply target id 时，才启用 group `reply_to_bot`。否则降级为：

```text
GROUP_AT_MESSAGE_CREATE
keyword
command_prefix
```

---

### 8.3 QQ Official Channel / Guild

`AT_MESSAGE_CREATE` 属于频道 / guild 语义，不归入 QQ group。

处理要求：

1. conversation kind 设为 `channel`。
2. AT_MESSAGE_CREATE 可作为平台 @bot hint。
3. 如果 payload 中存在 message_reference，并且指向 bot 历史消息，则优先触发 `reply_to_bot`。
4. `reply_to_bot` 优先级高于 `platform_at_event`。
5. 普通 MESSAGE_CREATE 不自动触发，只能由 mention / reply / keyword / command 触发。

---

### 8.4 QQ Official C2C / DM

首版将 QQ Official C2C / DM 归入 private 语义。

处理要求：

1. conversation kind 使用 `private`。
2. 复用 private trigger policy。
3. 复用 private history TTL。
4. 不新增 `dm` conversationType。
5. 后续如果 DM 和 C2C 差异扩大，再单独抽象。

---

## 9. 协议与数据结构变更说明

本节只说明变化，不要求在 PRD 中固定具体 TypeScript 实现。

### 9.1 MessageSegment

mention segment 需要增加目标语义：

| 字段           | 说明                      |
| -------------- | ------------------------- |
| target=user    | 明确 @ 某个用户           |
| target=all     | @全体                     |
| target=unknown | adapter 无法确认 @ 的目标 |

同时新增 reply segment，用于保留平台 reply 消息段。

兼容要求：

1. 旧数据没有 target 时按 `unknown` 处理。
2. Runtime 判断 reply 时优先使用 `message.replyTo.messageId`。
3. reply segment 主要用于保留原始消息结构。

---

### 9.2 SynapseMessage

消息对象需要支持 `replyTo`。

| 字段              | 说明                    |
| ----------------- | ----------------------- |
| replyTo.messageId | 被回复消息的平台消息 ID |

Adapter normalize 时应尽量填充该字段。

---

### 9.3 SynapseChannelEvent

事件对象需要增加两个能力区域：

| 字段                | 说明                               |
| ------------------- | ---------------------------------- |
| triggerHint         | adapter 从平台事件中提取的触发提示 |
| adapterCapabilities | 当前 adapter 支持哪些能力          |

triggerHint 至少需要表达：

| 字段                 | 说明                                    |
| -------------------- | --------------------------------------- |
| platformMentionedBot | 平台是否明确表示该消息 @bot             |
| repliedToBot         | Runtime enrich 后，该消息是否回复了 bot |
| platformEventType    | 原始平台事件类型                        |
| selfUserId           | 当前 bot 在该平台下的 self id           |
| replyTargetMessageId | 被回复消息 ID                           |

adapterCapabilities 至少需要表达：

| 能力                      | 说明                              |
| ------------------------- | --------------------------------- |
| mentionUser               | 是否能识别 @具体用户              |
| mentionAll                | 是否能识别 @全体                  |
| selfIdFromEvent           | 是否能从事件获取 bot 自身身份     |
| outgoingMessageId         | 发送后是否能获取消息 ID           |
| incomingReplyTarget       | 收到消息时是否能获取 reply target |
| platformMentionedBotHint  | 是否有平台级 @bot 事件            |
| replyToBot                | yes / no / conditional            |
| passiveReplyWindowSeconds | 平台被动回复窗口                  |

---

### 9.4 ConversationDecision

ConversationDecision 需要从粗粒度结果升级为结构化结果。

需要表达：

| 字段               | 说明                                                          |
| ------------------ | ------------------------------------------------------------- |
| shouldRespond      | 是否响应                                                      |
| reason             | 触发或忽略原因                                                |
| trigger.kind       | private / mention / reply / command / keyword / platform_hint |
| trigger.confidence | explicit / platform / heuristic                               |
| request            | 触发后生成的 AgentRequest                                     |

reason 至少覆盖：

```text
not_message
no_message
private_always
mentioned_bot
reply_to_bot
command_prefix
keyword
platform_at_event
not_triggered
mentioned_other_user
mention_all
unknown_mention_ignored
capability_not_supported
```

---

### 9.5 AgentRequest

AgentRequest 需要携带 trigger 信息，供 ContextComposer 和 trace 使用。

---

### 9.6 TranscriptMessage

TranscriptMessage 需要增加 `externalMessageId`。

用途：

1. 保存 bot 发送出去的消息 ID。
2. 未来用户回复该消息时，可以识别 `reply_to_bot`。
3. 支持重启后仍然判断回复目标。

---

### 9.7 externalMessageId normalize

不同平台返回的 message id 可能是 number、string、bigint，因此进入系统前必须统一为 string。

规则：

1. number 转 string。
2. bigint 转 string。
3. string trim 后为空则视为 undefined。
4. undefined / null 不参与匹配。
5. 写入 transcript 前 normalize。
6. 收到 replyTo.messageId 后 normalize。
7. number `123` 与 string `"123"` 必须能匹配。
8. externalMessageId 为空时不抛错，也不触发 reply_to_bot。

---

## 10. 配置变更

### 10.1 Context 配置

新增配置项：

| 配置                     |        默认值 | 说明                     |
| ------------------------ | ------------: | ------------------------ |
| timezone                 | Asia/Shanghai | prompt 中使用的时区      |
| privateHistoryTtlMinutes |           720 | 私聊历史 TTL             |
| groupHistoryTtlMinutes   |            30 | 群聊历史 TTL             |
| channelHistoryTtlMinutes |            30 | channel / guild 历史 TTL |
| privateMaxMessages       |            20 | 私聊最多历史消息数       |
| groupMaxMessages         |             6 | 群聊最多历史消息数       |
| channelMaxMessages       |             8 | channel 最多历史消息数   |

### 10.2 ConversationTriggerPolicy

新增配置项：

| 配置                       | 默认值 | 说明                           |
| -------------------------- | -----: | ------------------------------ |
| commandPrefixes            |  ["/"] | 命令前缀                       |
| allowCommandWithoutMention |   true | 群聊 command 是否允许无 @ 触发 |

说明：

1. 斜杠命令属于明确控制意图，默认允许无 @ 触发。
2. 如果部署者担心群聊误触发，可以关闭该配置。
3. 关闭后，群聊 command 必须同时满足 @bot / reply_to_bot / platformMentionedBot 之一。

### 10.3 OneBot11 channel 配置

新增可选配置：

| 配置       | 说明                                              |
| ---------- | ------------------------------------------------- |
| selfUserId | bot 自己的 QQ 号，作为 event.self_id 缺失时的回退 |

OneBot11 首选 `event.self_id`，配置只是 fallback。

### 10.4 QQ Official 配置

QQ Official 首版不强依赖 selfUserId。身份边界主要来自：

```text
appId
group_openid
guild_id
channel_id
user_openid
member_openid
```

---

## 11. Trigger 优先级

### 11.1 通用前置判断

所有消息先判断：

1. 非 message.created：不处理，reason 为 `not_message`。
2. message 为空：不处理，reason 为 `no_message`。

然后按 conversation kind 分流。

---

### 11.2 Private / C2C / DM

私聊优先级：

1. command_prefix。
2. keyword。
3. privateTrigger.mode = never。
4. privateTrigger.mode = always。
5. 其他不触发。

关键规则：

```text
command_prefix 必须优先于 private_always。
```

原因是 command 是控制语义，需要让 ContextComposer 知道这是一条命令，从而不带普通历史。

---

### 11.3 Group

群聊优先级：

1. command_prefix policy check。
2. repliedToBot = true 且 capability 支持。
3. 明确 @bot。
4. platformMentionedBot = true。
5. mention all。
6. mention other user。
7. unknown mention。
8. keyword。
9. 其他不触发。

关键规则：

```text
platformMentionedBot=true 独立触发，不依赖 mention segment。
```

---

### 11.4 Group command 策略

如果 `allowCommandWithoutMention = true`：

```text
/group 中 /command 可以直接触发
```

如果 `allowCommandWithoutMention = false`：

```text
/group 中 /command 需要同时满足：
- @bot
- reply_to_bot
- platformMentionedBot

三者之一
```

---

### 11.5 Channel / Guild

Channel / Guild 优先级：

1. command_prefix policy check。
2. reply target 指向 bot。
3. platformMentionedBot = true / AT_MESSAGE_CREATE。
4. 明确 @bot。
5. mention all。
6. mention other user。
7. keyword。
8. 其他不触发。

关键规则：

```text
reply_to_bot 优先于 AT_MESSAGE_CREATE。
```

原因是 AT_MESSAGE_CREATE 可能同时表示 @bot 和回复 bot，如果先命中 platform_at_event，会丢失 reply 语义。

---

## 12. Runtime 状态流

### 12.1 普通消息处理流

1. ChannelAdapter 接收平台事件。
2. Adapter normalize 为 SynapseChannelEvent。
3. Adapter 填充 triggerHint 与 adapterCapabilities。
4. RuntimeCore 执行 preRouteEnrich：

   - 合并 selfUserId；
   - normalize replyTo.messageId；
   - 如有 replyTo，查询是否回复 bot 历史消息。

5. ConversationRouter 判断是否触发。
6. 若未触发：

   - 记录 trace；
   - 不写 transcript；
   - 不调用 agent。

7. 若触发：

   - 解析 identity；
   - 解析 workspace；
   - 执行幂等 begin；
   - 写入 user transcript；
   - 合成 context；
   - 调用 agent；
   - 发送消息；
   - 写入 assistant transcript；
   - 如果发送结果有 message id，写入 externalMessageId；
   - 更新 process state。

---

### 12.2 @其他人

输入：

```text
@用户B 这个你看一下
```

期望：

```text
不回复
不写 transcript
reason = mentioned_other_user
```

---

### 12.3 @全体

输入：

```text
@全体 明天开会
```

期望：

```text
不回复
不写 transcript
reason = mention_all
```

---

### 12.4 @bot

输入：

```text
@Synapse 帮我总结一下
```

期望：

```text
回复
写入 transcript
reason = mentioned_bot
trigger.kind = mention
```

---

### 12.5 GROUP_AT_MESSAGE_CREATE

输入：

```text
QQ Official GROUP_AT_MESSAGE_CREATE
无 mention segment
platformMentionedBot = true
```

期望：

```text
回复
reason = platform_at_event
trigger.kind = platform_hint
```

---

### 12.6 GROUP_MESSAGE_CREATE

输入：

```text
QQ Official GROUP_MESSAGE_CREATE
无 command
无 keyword
无明确 @bot
```

期望：

```text
不回复
不写 transcript
reason = not_triggered
```

---

### 12.7 reply_to_bot

前置：

```text
bot 发送了一条消息，并保存 externalMessageId = 987
```

输入：

```text
用户回复 messageId = 987 的消息：继续
```

期望：

```text
回复
reason = reply_to_bot
trigger.kind = reply
```

如果回复的是其他人的消息：

```text
不回复
reason = not_triggered 或 capability_not_supported
```

---

## 13. Context TTL 与 Passive Reply Window

必须拆分两个概念。

### 13.1 Context TTL

Context TTL 控制历史是否进入 prompt。

默认值：

| conversation |     TTL |
| ------------ | ------: |
| private      | 720 min |
| group        |  30 min |
| channel      |  30 min |

### 13.2 Passive Reply Window

Passive reply window 控制平台是否允许基于某条消息被动回复。

默认值：

| 平台场景            |   窗口 |
| ------------------- | -----: |
| QQ Official C2C     |  3600s |
| QQ Official Group   |   300s |
| QQ Official Channel |   300s |
| QQ Official DM      |   300s |
| OneBot11 / NapCat   | 不适用 |

规则：

1. context TTL 过期只影响 prompt 历史。
2. passive reply window 过期只影响发送方式。
3. 两者不能共用字段。
4. 超过 passive reply window 时，QQ Official 不应继续使用 passive_reply。
5. 如果支持主动发送且权限允许，可以改走 active_send。
6. 如果不支持主动发送，记录 send_failed。

---

## 14. ContextComposer 策略

### 14.1 历史 TTL

ContextComposer 根据 conversation type 选择 TTL：

| conversation | 使用配置                 |
| ------------ | ------------------------ |
| private      | privateHistoryTtlMinutes |
| group        | groupHistoryTtlMinutes   |
| channel      | channelHistoryTtlMinutes |

超过 TTL 的历史默认不进入 prompt。

---

### 14.2 按 trigger kind 决定历史数量

| conversation | trigger        | 历史策略              |
| ------------ | -------------- | --------------------- |
| private      | private_always | 带 privateMaxMessages |
| private      | command        | 不带普通历史          |
| private      | keyword        | 带少量历史            |
| private      | reply          | 带 privateMaxMessages |
| group        | command        | 不带普通历史          |
| group        | mention        | 带 groupMaxMessages   |
| group        | platform_hint  | 带 groupMaxMessages   |
| group        | keyword        | 带少量历史            |
| group        | reply          | 带 groupMaxMessages   |
| channel      | command        | 不带普通历史          |
| channel      | platform_hint  | 带 channelMaxMessages |
| channel      | keyword        | 带少量历史            |
| channel      | reply          | 带 channelMaxMessages |

### 14.3 command 不带普通历史

以下场景默认不带普通聊天历史：

```text
private + command_prefix
group + command_prefix
channel + command_prefix
```

原因：

```text
/whoami
/workspace info
/memory
```

这类命令是控制语义，不应该被普通聊天历史污染。

---

### 14.4 当前消息不重复进入 history

当前 incoming user message 会先 append transcript，再 compose context。

因此 ContextComposer 必须过滤：

```text
sourceEventId == currentSourceEventId 的消息
```

避免当前用户消息既作为当前输入，又重复出现在历史中。

---

### 14.5 历史消息时间格式

历史消息进入 prompt 时必须带时间信息，例如：

```text
[2026-07-05 22:10, 13m ago] user: ...
[2026-07-05 22:11, 12m ago] assistant: ...
```

当前用户输入不加历史时间前缀。

---

### 14.6 Prompt metadata

PromptContext metadata 至少包含：

| 字段                     | 说明                  |
| ------------------------ | --------------------- |
| currentTimeIso           | 当前时间              |
| eventReceivedAt          | 当前事件接收时间      |
| timezone                 | 当前时区              |
| triggerKind              | 本轮触发类型          |
| triggerReason            | 本轮触发原因          |
| adapter                  | 当前 adapter          |
| adapterCapabilityProfile | 当前 adapter 能力概要 |

---

### 14.7 System prompt 约束

ContextComposer 生成的 system prompt 必须强调：

```text
1. 当前用户输入是最高优先级。
2. 历史消息只是背景。
3. 不要自动继续旧话题。
4. 只有当前消息明确引用、继续、回复旧话题时，才使用历史。
5. 如果当前消息是问候、确认、表情或新话题，只回应当前消息。
```

群聊额外强调：

```text
1. 避免复活旧话题。
2. 只回应当前明确触发。
3. 保持简洁。
```

---

## 15. 数据库变更

### 15.1 conversation_messages

新增字段：

| 字段                | 说明                                  |
| ------------------- | ------------------------------------- |
| external_message_id | 平台侧消息 ID，用于 reply_to_bot 匹配 |

新增索引：

```text
session_id + external_message_id + role + deleted_at
```

用途：

```text
快速判断用户回复的消息是否是 bot 发送过的 assistant 消息。
```

### 15.2 event_process_state

可选新增字段：

| 字段                             | 说明                                      |
| -------------------------------- | ----------------------------------------- |
| send_mode                        | passive_reply / active_send / unsupported |
| platform_reply_window_expires_at | 平台被动回复窗口过期时间                  |

### 15.3 迁移兼容

1. 旧库没有字段时自动迁移。
2. 重复迁移不能报错。
3. 旧 transcript 的 external_message_id 为 NULL。
4. 不影响 source_event_id 幂等逻辑。
5. externalMessageId 写入失败不能影响消息发送成功。
6. externalMessageId 为空不参与 reply_to_bot 匹配。

---

## 16. Session 与身份边界

### 16.1 Session ID

推荐 sessionId 至少包含：

```text
platform
provider / adapter
botScopeId
conversationType
conversationId
```

其中：

```text
OneBot11:
botScopeId = self_id 或 channelId

QQ Official:
botScopeId = appId 或 channelId
```

### 16.2 QQ Official 身份边界

QQ Official 的 openid 不应被当成全局用户 ID。

身份规则：

1. 不同 bot 下的 openid 不互通。
2. 同一用户在不同群里的 member_openid 不能视为同一个全局用户。
3. group identity 应包含 appId、group_openid、member_openid。
4. c2c identity 应包含 appId、user_openid。
5. channel identity 应包含 appId、channel_id、user_openid。

---

## 17. Package 影响面

### 17.1 packages/protocol

需要修改：

1. mention segment 增加 target 语义。
2. 增加 reply 表达能力。
3. SynapseMessage 支持 replyTo。
4. SynapseChannelEvent 支持 triggerHint。
5. SynapseChannelEvent 支持 adapterCapabilities。
6. transcript 支持 externalMessageId。

### 17.2 packages/channel-onebot11

需要修改：

1. 解析 event.self_id。
2. 精准解析 at.qq。
3. 区分 @用户、@全体、unknown mention。
4. 解析 reply 段。
5. 发送结果中提取 message_id。
6. 声明 adapterCapabilities。

### 17.3 packages/channel-qq-official

需要修改：

1. GROUP_AT_MESSAGE_CREATE 设置 platformMentionedBot=true。
2. GROUP_MESSAGE_CREATE 设置 platformMentionedBot=false。
3. AT_MESSAGE_CREATE 映射为 channel / guild。
4. MESSAGE_CREATE 不自动触发。
5. 有 message_reference 时映射 replyTo。
6. C2C / DM 映射为 private。
7. 根据场景设置 passiveReplyWindowSeconds。
8. PR-6 中根据实测 payload 继续补齐 capability。

### 17.4 packages/conversation

需要修改：

1. ConversationDecision 结构化。
2. trigger reason 细化。
3. 支持 command_prefix。
4. 支持 allowCommandWithoutMention。
5. 支持 mentioned_bot / mentioned_other_user / mention_all / unknown_mention。
6. 支持 platformMentionedBot 独立触发。
7. 支持 repliedToBot。
8. 支持 capability_not_supported。

### 17.5 packages/runtime-core

需要修改：

1. route 前增加 preRouteEnrich。
2. preRouteEnrich 负责 reply_to_bot 查询。
3. append assistant transcript 时写 externalMessageId。
4. ContextComposer 增加时间上下文。
5. ContextComposer 支持 TTL。
6. ContextComposer 按 trigger kind 控制历史。
7. Runtime trace 输出 trigger reason。
8. SQLite store 支持 migration。

### 17.6 packages/runtime-server

需要修改：

1. 新 context 配置透传 RuntimeCore。
2. channel.selfUserId 传递 adapter。
3. adapter capability 可在 status / debug 中展示。
4. config reload 兼容新字段。

### 17.7 packages/agent-api-provider

基本不需要改 provider 调用，只需要确认：

1. promptContext.system 仍作为 system message 注入。
2. promptContext.messages 中的时间前缀不会被丢弃。
3. 当前用户输入保持原样。

---

## 18. PR 拆分

### PR-1：Protocol + OneBot11 mention 精准化 + QQ Official event hint

目标：

```text
解决 @ 误触发，建立平台 hint 基础。
```

范围：

```text
packages/protocol
packages/channel-onebot11
packages/channel-qq-official
packages/conversation
tests
```

内容：

1. mention 增加 target 语义。
2. OneBot11 at.qq 精准解析。
3. OneBot11 event.self_id 注入 selfUserId。
4. QQ Official GROUP_AT_MESSAGE_CREATE 设置 platformMentionedBot=true。
5. QQ Official GROUP_MESSAGE_CREATE 设置 platformMentionedBot=false。
6. platformMentionedBot=true 可独立触发。
7. unknown mention 默认不触发。

验收：

1. @其他人 不触发。
2. @全体 不触发。
3. @bot 触发。
4. GROUP_AT_MESSAGE_CREATE 无 mention segment 仍触发。
5. GROUP_MESSAGE_CREATE 不自动触发。

---

### PR-2：ConversationDecision 结构化 + trigger trace

目标：

```text
让 Runtime 能解释每次触发或忽略原因。
```

范围：

```text
packages/conversation
packages/runtime-core
packages/agent-core
tests
docs
```

内容：

1. ConversationDecision 结构化。
2. 增加 trigger reason。
3. AgentRequest 携带 trigger。
4. RuntimeTrace 输出 reason。
5. 日志记录 trigger.kind / reason / confidence。

验收：

trace 中能看到：

```text
mentioned_bot
mentioned_other_user
mention_all
unknown_mention_ignored
platform_at_event
command_prefix
keyword
reply_to_bot
capability_not_supported
```

---

### PR-3：Context time injection

目标：

```text
让模型知道当前时间与历史时间距离。
```

范围：

```text
packages/config
packages/runtime-core
packages/agent-api-provider
examples/runtime.config.toml
docs
tests
```

内容：

1. context 增加 timezone。
2. PromptContext metadata 增加 currentTimeIso。
3. PromptContext metadata 增加 eventReceivedAt。
4. 历史消息带时间前缀。
5. system prompt 增加当前输入优先规则。

验收：

1. prompt 中有当前时间。
2. prompt 中有事件时间。
3. prompt 中有 timezone。
4. 历史消息带时间。
5. 当前用户输入不加历史前缀。

---

### PR-4：Context TTL + trigger-based history policy

目标：

```text
解决旧话题每轮续答。
```

范围：

```text
packages/config
packages/runtime-core
tests
docs
examples
```

内容：

1. 增加 private / group / channel TTL。
2. 增加 private / group / channel maxMessages。
3. 按 trigger kind 决定历史策略。
4. command 默认不带普通历史。
5. 当前 sourceEventId 不重复进入 history。

验收：

1. 超过 group TTL 的历史不进入 prompt。
2. 超过 private TTL 的历史默认不进入 prompt。
3. command 不带普通历史。
4. reply 带近期相关历史。
5. 普通问候不会续答旧话题。
6. 当前消息不重复出现在 history。

---

### PR-5：externalMessageId migration + OneBot11 / NapCat reply_to_bot

目标：

```text
首版支持 OneBot11 / NapCat reply_to_bot。
```

范围：

```text
packages/protocol
packages/channel-onebot11
packages/runtime-core
SQLite migration
tests
```

内容：

1. conversation_messages 增加 external_message_id。
2. assistant transcript 写入发送返回的 messageId。
3. OneBot11 reply.data.id 映射 replyTo.messageId。
4. RuntimeCore route 前查询 repliedToBot。
5. 支持 number / string messageId normalize。
6. OneBot11 / NapCat reply_to_bot 首版必达。

验收：

1. 回复 bot 消息触发。
2. 回复其他人消息不触发。
3. 重启后仍可识别 reply_to_bot。
4. externalMessageId 为空不报错。
5. number 与 string ID 可匹配。

---

### PR-6：QQ Official capability refinement

目标：

```text
基于真实 payload 精修 QQ Official capability。
```

范围：

```text
packages/channel-qq-official
packages/runtime-core
packages/conversation
tests
docs
```

内容：

1. 根据实测 payload 补齐 group / channel / private capability。
2. channel/guild message_reference 指向 bot 时支持 reply_to_bot。
3. QQ Official group 仅在有明确 reply target id 时启用 reply_to_bot。
4. C2C / DM 归入 private。
5. passive reply window 与 send mode 适配。

验收：

1. channel AT_MESSAGE_CREATE + message_reference 指向 bot 时触发 reply_to_bot。
2. group 无 reply target id 时不启用 reply_to_bot。
3. QQ Official group reply_to_bot 不阻塞 PR-5。
4. passive reply window 过期后不走 passive_reply。

---

## 19. 测试用例

### 19.1 ConversationRouter

1. group mention botUserIds 命中，reason 为 `mentioned_bot`。
2. group mention 其他 userId，reason 为 `mentioned_other_user`。
3. group mention all，reason 为 `mention_all`。
4. group unknown mention 且无 platform hint，reason 为 `unknown_mention_ignored`。
5. group unknown mention 且 platformMentionedBot=true，reason 为 `platform_at_event`。
6. GROUP_AT_MESSAGE_CREATE 无 mention segment，但 platformMentionedBot=true，reason 为 `platform_at_event`。
7. group keyword 命中，reason 为 `keyword`。
8. group command_prefix 命中，reason 为 `command_prefix`。
9. private mode always + command_prefix，reason 为 `command_prefix`，不是 `private_always`。
10. private always 普通消息，reason 为 `private_always`。
11. mode never 不触发。
12. repliedToBot + capability yes，reason 为 `reply_to_bot`。
13. repliedToBot + capability no，reason 为 `capability_not_supported`。
14. channel AT_MESSAGE_CREATE + message_reference 指向 bot，reason 为 `reply_to_bot`，优先于 `platform_at_event`。
15. group command_prefix 未 @bot 时，按 allowCommandWithoutMention 配置验证。

---

### 19.2 OneBot11 / NapCat

1. event.self_id 被写入 selfUserId。
2. `[CQ:at,qq=123]` 识别为 mention user。
3. `[CQ:at,qq=all]` 识别为 mention all。
4. malformed at 识别为 unknown mention。
5. `[CQ:reply,id=456]` 映射为 replyTo.messageId。
6. send_group_msg 返回 message_id 后写入 externalMessageId。
7. @其他人 不触发。
8. @全体 不触发。
9. @bot 触发。
10. 回复 bot 触发。
11. 回复其他人不触发。

---

### 19.3 QQ Official Group

1. GROUP_AT_MESSAGE_CREATE 设置 platformMentionedBot=true。
2. GROUP_AT_MESSAGE_CREATE 无 mention segment 仍触发。
3. GROUP_MESSAGE_CREATE 设置 platformMentionedBot=false。
4. GROUP_MESSAGE_CREATE 无 keyword / command 不触发。
5. GROUP_MESSAGE_CREATE + keyword 触发。
6. GROUP_MESSAGE_CREATE + command 按配置触发。
7. group send 返回 id 时写入 externalMessageId。
8. 无 reply target id 时不启用 reply_to_bot。

---

### 19.4 QQ Official Channel / Guild

1. AT_MESSAGE_CREATE 映射为 channel。
2. AT_MESSAGE_CREATE 设置 platformMentionedBot=true。
3. message_reference 指向 bot 时触发 reply_to_bot。
4. reply_to_bot 优先于 platform_at_event。
5. MESSAGE_CREATE 不自动触发。

---

### 19.5 ContextComposer

1. metadata 包含 currentTimeIso。
2. metadata 包含 eventReceivedAt。
3. metadata 包含 timezone。
4. 历史消息包含时间前缀。
5. 当前用户输入不加历史时间前缀。
6. group 超过 TTL 的历史不进入 prompt。
7. private TTL 内历史进入 prompt。
8. private command trigger 不带普通历史。
9. group command trigger 不带普通历史。
10. channel command trigger 不带普通历史。
11. group keyword 只带少量历史。
12. reply trigger 带近期历史。
13. 当前 sourceEventId 对应 user message 不重复出现在 history 中。
14. current input first system prompt 存在。

---

### 19.6 Reply Matching

1. assistant externalMessageId 是 number，replyTo.messageId 是 string，仍可匹配。
2. assistant externalMessageId 是 string，replyTo.messageId 是 number，仍可匹配。
3. assistant externalMessageId 为空时不抛错。
4. assistant externalMessageId 为空时不触发 reply_to_bot。
5. replyTo.messageId 为空时不触发 reply_to_bot。

---

### 19.7 RuntimeCore 集成测试

1. @其他人 不调用 agent，不写 transcript。
2. @全体 不调用 agent，不写 transcript。
3. @bot 调用 agent，写 transcript。
4. GROUP_AT_MESSAGE_CREATE 调用 agent。
5. GROUP_MESSAGE_CREATE 不自动调用 agent。
6. 第二轮请求带时间上下文。
7. 超过 TTL 后不续答旧话题。
8. assistant transcript 写 externalMessageId。
9. duplicate event 仍按原幂等逻辑处理。
10. 未触发群消息不写 transcript。

---

### 19.8 Passive Reply Window

1. QQ Official group 被动回复窗口为 300 秒。
2. QQ Official C2C 被动回复窗口为 3600 秒。
3. 超出窗口不使用 passive_reply。
4. context TTL 不影响 passive reply window。

---

## 20. 配置示例

```toml
[context]
enabled = true
maxHistoryChars = 6000
timezone = "Asia/Shanghai"
privateHistoryTtlMinutes = 720
groupHistoryTtlMinutes = 30
channelHistoryTtlMinutes = 30
privateMaxMessages = 20
groupMaxMessages = 6
channelMaxMessages = 8

[conversation.privateTrigger]
mode = "always"
commandPrefixes = ["/"]

[conversation.groupTrigger]
mode = "mention_or_keyword"
keywords = ["Synapse"]
botUserIds = []
commandPrefixes = ["/"]
allowCommandWithoutMention = true

[channels."qq-local"]
adapter = "onebot11"
provider = "napcat"
transport = "websocket"
endpoint = "ws://127.0.0.1:3001"
selfUserId = "${QQ_SELF_ID:-}"
enabled = true
riskLevel = "high"

[channels."qq-official"]
adapter = "qq-official"
appId = "${QQ_BOT_APP_ID}"
appSecret = "${QQ_BOT_APP_SECRET}"
mode = "webhook"
webhookPath = "/webhooks/qq-official/qq-official"
enabled = true
riskLevel = "low"
```

---

## 21. 验收标准

### 21.1 功能验收

1. 群聊 @其他人 时 bot 不回复。
2. 群聊 @全体 时 bot 不回复。
3. 群聊 @bot 时 bot 回复。
4. OneBot11 / NapCat 可从 event.self_id 识别 bot 身份。
5. OneBot11 / NapCat 回复 bot 消息时 bot 回复。
6. OneBot11 / NapCat 回复其他人消息时 bot 不回复。
7. QQ Official GROUP_AT_MESSAGE_CREATE 可触发。
8. QQ Official GROUP_MESSAGE_CREATE 不自动触发。
9. QQ Official AT_MESSAGE_CREATE 归入 channel / guild。
10. QQ Official C2C / DM 归入 private。
11. 普通群消息不会因为历史话题存在而回复。
12. 历史消息进入 prompt 时带时间。
13. 超过 TTL 的历史不再导致旧话题续答。
14. command trigger 默认不带普通历史。
15. 当前消息不重复进入 history。
16. context TTL 与 passive reply window 分离。
17. 未触发群消息不写入 transcript。
18. trace 能说明触发或忽略原因。

---

### 21.2 工程验收

1. `pnpm -r typecheck` 通过。
2. `pnpm -r test` 通过。
3. mention / trigger / context TTL / reply_to_bot / passive window 均有测试。
4. `docs/reference/config.md` 更新。
5. `docs/guide/runtime-flow.md` 更新。
6. `examples/runtime.config.toml` 更新。
7. 新增或更新 Adapter Capability Matrix 文档。
8. SQLite migration 对旧库兼容。
9. PR-5 不因 QQ Official group reply_to_bot 未确认而阻塞。
10. PR-6 可独立跟进 QQ Official 实测 payload。

---

## 22. 风险与处理

### 22.1 OneBot11 event.self_id 缺失

处理：

1. 回退 channel.selfUserId。
2. 再回退 conversation.groupTrigger.botUserIds。
3. 仍为空则 unknown mention 不触发。
4. 输出 warning。

### 22.2 QQ Official 文档字段与真实 payload 不一致

处理：

1. 默认 conservative capability。
2. payload 中实际存在 message_reference / reply target id 才启用。
3. 记录 raw payload debug log。
4. 不把未确认能力写成强验收。

### 22.3 GROUP_MESSAGE_CREATE 文档描述歧义

处理：

```text
GROUP_MESSAGE_CREATE = 全量群消息
不等价于 @bot
只允许 keyword / command / 明确 payload hint 触发
```

### 22.4 时间前缀污染模型输入

处理：

1. 只给历史消息加时间前缀。
2. 当前用户输入保持原样。
3. system prompt 说明历史是背景。
4. 超过 TTL 的历史不进入 prompt。

### 22.5 context TTL 和 passive reply window 混淆

处理：

1. context TTL 只影响 prompt。
2. passive reply window 只影响发送。
3. 两者分别配置和记录。
4. 超出平台窗口时不尝试 passive_reply。

---

## 23. 推荐研发顺序

```text
第一阶段：
PR-1 mention 误触发修复

第二阶段：
PR-2 TriggerDecision 结构化

第三阶段：
PR-3 时间上下文注入
PR-4 TTL 与上下文策略

第四阶段：
PR-5 OneBot11 / NapCat reply_to_bot

第五阶段：
PR-6 QQ Official capability refinement
```

不要把 PR-1 和 PR-4 混在一起。

原因：

```text
PR-1 解决“该不该回复”。
PR-4 解决“回复时该不该带历史”。
```

如果混做，回归时很难定位问题来自触发层还是上下文层。

---

## 24. 最终交付效果

迭代完成后，Synapse Runtime 应具备以下能力：

1. 知道谁在 @bot。
2. 知道谁在 @别人。
3. 知道 @全体 不是 @bot。
4. 知道 platform @bot 事件可以独立触发。
5. OneBot11 / NapCat 能可靠支持 reply_to_bot。
6. QQ Official group / channel / private 语义不混用。
7. QQ Official group reply_to_bot 不阻塞首版。
8. 模型知道当前时间和历史时间距离。
9. 旧话题不会每轮自动续答。
10. context TTL 与平台被动回复窗口分离。
11. 未触发群消息仍不写入 transcript。
12. Runtime trace 能解释每一次响应或忽略的原因。

需要注意的点：

1. 明确 privateTrigger.mode = never 的语义。
2. 统一 trigger.kind 和 reason 的命名边界。
3. 补充 group command policy 需要预计算 addressed signals。
4. 调整 preRouteEnrich 顺序：reply_to_bot 查询前必须先构造 SessionKey。
5. 新增 reply_to_non_bot_message reason。

ordinary message 不作为常规回复触发源，之后迭代补齐agent loop的判断逻辑；
@bot = 强触发
reply_to_bot = 强触发
command_prefix = 强触发，受 group command policy 控制
keyword = 中触发
@all = 弱触发 / 广播触发，受 mentionAllPolicy 控制
ordinary message = 不触发

本迭代完成后，Synapse Runtime 将从“粗粒度消息 Bot Runtime”推进到“按平台能力精确触发、按时间边界合成上下文的稳定 Agent Runtime”。
