# Synapse Runtime P0 上下文合成闭环 PRD

## 1. 文档信息

**项目名称**：Synapse Runtime
**文档名称**：P0 上下文合成闭环 PRD
**版本**：v0.3
**文档类型**：产品需求文档 / 架构落地 PRD
**目标阶段**：P0a / P0b / P0c 可开发排期，P0d 可选
**核心范围**：身份识别、会话历史落盘、上下文合成、输出策略、工作区边界、幂等恢复
**非核心范围**：完整长期记忆、主动触发、Workflow、Project Workspace、向量检索、多 Agent、复杂用户绑定

---

## 2. 一句话目标

> 在不破坏现有 Synapse Runtime 链路的前提下，让 Runtime 能够稳定识别平台用户，保存并读取最近会话历史，区分私聊与群聊工作区，合成可控上下文供 Agent 使用，并在失败时安全降级为旧单轮链路。

---

## 3. 背景

当前 Synapse Runtime 已经具备基础消息链路：

```text
Channel Event
  ↓
ConversationRouter
  ↓
Agent.run
  ↓
Permission
  ↓
Channel.sendMessage
```

当前仓库中已有核心模块：

```text
packages/runtime-core
packages/conversation
packages/agent-core
packages/agent-api-provider
packages/channel
packages/channel-onebot11
packages/channel-qq-official
packages/permission
packages/tool-runtime
packages/protocol
packages/config
packages/runtime-server
```

这说明系统已经不是空项目，而是具备：

```text
通道接入
对话路由
模型调用
权限检查
消息发送
配置加载
运行时入口
```

但当前系统仍更接近 **单轮消息 Bot Runtime**，还不是具备稳定上下文能力的 Agent Runtime。

主要问题包括：

1. `ConversationRouter` 虽然存在 `contextPolicy.includeHistory` 等字段，但没有真实历史读取；
2. Agent Provider 当前主要消费 `systemPrompt + 当前用户输入`，不消费历史、身份、工作区、输出策略；
3. 缺少 TranscriptStore，无法保存和回放最近历史；
4. 缺少 IdentityResolver，平台 sender id 直接混入业务逻辑；
5. 缺少 WorkspaceResolver，无法区分私聊、群聊、CLI、系统管理场景；
6. 缺少 ContextComposer，无法统一合成 Agent 所需上下文；
7. 缺少 ResponsePolicy，群聊输出容易刷屏；
8. 缺少完整事件处理状态，无法安全处理平台重投、进程崩溃和发送副作用幂等；
9. 群聊、私聊、CLI 的上下文读取和输出策略尚未形成稳定边界。

因此，P0 的目标不是做完整长期记忆系统，而是先完成一个最小但稳定的 **上下文合成闭环**。

---

## 4. P0 交付边界

### 4.1 P0 必交付

P0 必须交付以下三部分：

```text
P0a：IdentityResolver Lite + TranscriptStore + Recent History + ContextComposer Skeleton
P0b：ResponsePolicy + 群聊隔离 + 规则截断
P0c：Workspace Lite + /workspace info
```

### 4.2 P0 可选交付

```text
P0d：Durable Memory Lite
```

P0d 不阻塞 P0a / P0b / P0c 上线。

如果 P0d 延后，系统仍应具备：

```text
1. 同一平台用户的稳定 guest identity；
2. 私聊最近历史上下文；
3. 群聊触发边界；
4. 群聊短答策略；
5. personal/group/system workspace 区分；
6. ContextComposer 失败时降级旧单轮链路。
```

---

## 5. P0 非目标

P0 不做以下内容：

```text
复杂用户绑定迁移
多平台身份合并
Project Workspace 自动推断
Related Workspace 自动推断
自动长期记忆总结
向量数据库
MemoryPromoter 自动化
TriggerRuntime
WorkflowRuntime
Affective State
动态插件系统
复杂权限后台
完整隐私管理 UI
多 Agent 协作
Planner
```

这些能力进入 P1 / P2。

---

## 6. 核心术语

### 6.1 PlatformIdentity

平台身份，表示消息从哪个平台账号来。

示例：

```text
onebot11 / napcat / qq-local / 123456
qq-official / official / qq-official-main / openid_xxx
cli / local / cli-local / ubuntu
web / app / web-default / user_001
```

P0 数据结构：

```ts
interface PlatformIdentity {
  platform: string;
  provider: string;
  channelId: string;
  platformUserId: string;
  displayName?: string;
}
```

---

### 6.2 SynapseIdentity

Synapse Runtime 内部身份。

P0 只需要三类：

```text
guest
owner
system
```

P0 数据结构：

```ts
interface SynapseIdentity {
  id: string;
  type: "guest" | "owner" | "system";
  trustLevel: "guest" | "owner" | "system";
  displayName?: string;
  roles: string[];
}
```

---

### 6.3 RuntimeActor

一次事件中的操作者。

```ts
interface RuntimeActor {
  identity: SynapseIdentity;
  platformIdentity: PlatformIdentity;
  isBound: boolean;
}
```

P0 中，`isBound` 通常为 `false`，除非已有 owner 预设或未来绑定能力启用。

---

### 6.4 Conversation

通信上下文，表示消息从哪里来、回复发到哪里。

P0 支持：

```text
private
group
cli
system
```

---

### 6.5 Session

Session 是某个 Conversation 下的一段连续上下文。

P0 不做复杂时间窗口切分。

同一 `sessionId` 下的消息按时间倒序读取最近历史。

---

### 6.6 Workspace

Workspace 是能力上下文，表示当前场景使用什么规则。

P0 只支持：

```text
personal
group
system
```

P0 不支持：

```text
project
repository
organization
related workspace
```

一句话：

> Conversation 决定消息在哪里通信，Workspace 决定这次交互属于哪个能力场景。

---

### 6.7 Transcript

原始会话事实记录。

P0 只保存：

```text
被 Runtime 处理的用户消息
成功发送的 assistant 回复
必要 command 结果
```

默认不保存：

```text
群聊中未触发 bot 的普通消息
发送失败的 assistant 草稿
未授权工具结果
无关系统事件
```

---

### 6.8 ContextComposer

上下文合成器。

负责把：

```text
event
actor
workspace
recent history
output policy
current input
```

合成为 Agent Provider 可消费的 `PromptContext`。

---

### 6.9 ResponsePolicy

输出策略。

负责在消息发送前统一处理：

```text
长度
段落数
Markdown
CodeBlock
是否拆分
是否提示展开
```

P0 ResponsePolicy 不二次调用 LLM。

---

## 7. 总体链路

### 7.1 当前链路

```text
ChannelAdapter
  ↓
RuntimeCore.handleChannelEvent
  ↓
ConversationRouter.route
  ↓
Agent.run
  ↓
Permission
  ↓
Channel.sendMessage
```

---

### 7.2 P0 目标链路

```text
ChannelAdapter
  ↓
RuntimeCore.handleChannelEvent
  ↓
ConversationRouter.route
  ↓
IdentityResolver.resolve
  ↓
WorkspaceResolver.resolve
  ↓
Idempotency.begin / event_process_state
  ↓
TranscriptStore.appendIncoming
  ↓
ContextComposer.compose
  ↓
Agent.run
  ↓
ResponsePolicy.apply
  ↓
Channel.sendMessage
  ↓
TranscriptStore.appendAssistant
  ↓
Idempotency.complete
```

---

### 7.3 为什么先 route 再 appendIncoming

P0 不默认保存所有群消息。

尤其是群聊中未触发 bot 的普通消息，默认不应保存，否则会带来：

```text
隐私风险
噪声污染
上下文膨胀
误记忆
```

因此顺序必须是：

```text
先判断是否需要处理
再写 transcript
```

---

## 8. ID 规则

## 8.1 channelId

`channelId` 表示 Runtime 内部注册的 Channel 实例 ID。

示例：

```text
qq-local
qq-official-main
cli-local
web-default
runtime-server
```

它不等于平台账号 ID，也不一定等于 adapter 名称。

---

## 8.2 conversationType

P0 支持：

```text
private
group
cli
system
```

---

## 8.3 conversationId

P0 采用纯平台目标 ID，不带 `private:` 或 `group:` 前缀。

### 私聊

```text
conversationType = private
conversationId = platformUserId
```

示例：

```text
conversationType = private
conversationId = 123456
```

### 群聊

```text
conversationType = group
conversationId = platformGroupId
```

示例：

```text
conversationType = group
conversationId = 888888
```

### CLI

```text
conversationType = cli
conversationId = terminalSessionId || default
```

示例：

```text
conversationType = cli
conversationId = default
```

### System / Admin

```text
conversationType = system
conversationId = runtime-admin
```

---

## 8.4 sessionId

P0 使用确定性 sessionId：

```text
sessionId =
  platform + ":" +
  provider + ":" +
  channelId + ":" +
  conversationType + ":" +
  conversationId
```

示例：

```text
onebot11:napcat:qq-local:private:123456
onebot11:napcat:qq-local:group:888888
cli:local:cli-local:cli:default
system:runtime:runtime-server:system:runtime-admin
```

---

## 8.5 session 生命周期

P0 不做：

```text
按时间窗口切分 session
按 reply thread 切分 session
按 workflow instance 切分 session
按 task scope 切分 session
```

P1 再引入更复杂 session 策略。

---

## 9. sourceEventId 与幂等

## 9.1 sourceEventId 定义

`sourceEventId` 表示平台事件稳定 ID。

优先使用平台原生 ID：

```text
OneBot message_id
QQ Official event id
Webhook delivery id
CLI input sequence id
```

---

## 9.2 sourceEventId 唯一命名空间

P0 不假设 `sourceEventId` 在整个 channel 内全局唯一。

去重命名空间为：

```text
platform
provider
channelId
conversationType
conversationId
sourceEventId
```

对应唯一索引：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_source_event
ON conversation_messages(
  platform,
  provider,
  channel_id,
  conversation_type,
  conversation_id,
  source_event_id
)
WHERE source_event_id IS NOT NULL;
```

---

## 9.3 best-effort sourceEventId

如果平台没有稳定事件 ID，Runtime 可生成弱去重 ID。

优先使用：

```text
hash(
  platform +
  provider +
  channelId +
  conversationType +
  conversationId +
  platformUserId +
  messageText +
  platformTimestampRounded
)
```

如果平台没有时间戳，再退回：

```text
hash(
  platform +
  provider +
  channelId +
  conversationType +
  conversationId +
  platformUserId +
  messageText +
  receivedAtRounded
)
```

说明：

```text
使用 receivedAtRounded 生成的 sourceEventId 只属于弱去重，不保证跨重投稳定。
```

---

## 10. 发送副作用幂等

## 10.1 问题背景

仅对 incoming transcript 做去重不足以保证完整链路幂等。

需要处理以下异常场景：

```text
1. Agent 已生成，但 sendMessage 前崩溃；
2. sendMessage 成功，但 assistant transcript 未写入；
3. sendMessage 失败后平台重投；
4. sourceEventId 重复投递导致重复回复；
5. 进程重启后不知道事件处理到哪一步。
```

因此 P0 引入 `event_process_state` 表。

---

## 10.2 event_process_state schema

```sql
CREATE TABLE event_process_state (
  id TEXT PRIMARY KEY,

  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  conversation_type TEXT NOT NULL
    CHECK(conversation_type IN ('private', 'group', 'cli', 'system')),

  conversation_id TEXT NOT NULL,

  source_event_id TEXT NOT NULL,

  status TEXT NOT NULL
    CHECK(status IN (
      'received',
      'processing',
      'agent_completed',
      'send_succeeded',
      'send_failed',
      'completed'
    )),

  incoming_message_id TEXT,
  assistant_message_id TEXT,

  agent_output_text TEXT,
  agent_output_json TEXT,

  send_result_json TEXT,
  error_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY(incoming_message_id) REFERENCES conversation_messages(id),
  FOREIGN KEY(assistant_message_id) REFERENCES conversation_messages(id)
);

CREATE UNIQUE INDEX idx_event_process_unique
ON event_process_state(
  platform,
  provider,
  channel_id,
  conversation_type,
  conversation_id,
  source_event_id
);
```

---

## 10.3 状态含义

| 状态            | 含义                                                 |
| --------------- | ---------------------------------------------------- |
| received        | 事件已接收，尚未开始 Agent 处理                      |
| processing      | Agent 正在处理或准备处理                             |
| agent_completed | Agent 已完成，尚未发送或发送状态未知                 |
| send_succeeded  | 消息已发送成功，但 assistant transcript 可能尚未写入 |
| send_failed     | 消息发送失败，可根据策略重试                         |
| completed       | 发送成功且 assistant transcript 已写入，事件闭环完成 |

---

## 10.4 处理流程

```text
1. 收到可处理事件；
2. 根据 sourceEventId upsert event_process_state；
3. 如果不存在，创建 status = received；
4. 写 incoming transcript；
5. 更新 status = processing；
6. 调用 Agent；
7. 保存 agent output，更新 status = agent_completed；
8. 调用 sendMessage；
9. 成功后更新 status = send_succeeded；
10. 写 assistant transcript；
11. 更新 status = completed。
```

---

## 10.5 重复事件处理规则

### status = completed

```text
直接 noop。
不重复调用 Agent。
不重复发送消息。
记录 duplicate_event audit 可选。
```

### status = processing

```text
如果 updated_at 很近：
  返回 already_processing / noop。

如果 updated_at 超过 processingTimeout：
  记录 audit，允许恢复处理或标记 send_failed。
```

P0 默认：

```text
processingTimeout = 5 minutes
```

### status = received

```text
允许继续处理。
```

### status = agent_completed

```text
优先复用 agent_output_text。
不重新调用 Agent。
继续执行 sendMessage。
```

### status = send_failed

```text
允许重试发送。
不重新调用 Agent，除非 agent_output 缺失。
```

### status = send_succeeded 但 assistant_message_id 为空

```text
补写 assistant transcript。
更新 status = completed。
不重复发送消息。
```

---

## 10.6 sendMessage 与 transcript 顺序

P0 保持：

```text
sendMessage 成功后，再写 assistant transcript。
```

原因：

```text
避免用户没收到消息，但系统历史里出现 assistant 已回复。
```

如果 sendMessage 成功但写 transcript 失败：

```text
event_process_state.status = send_succeeded
后续重复事件或恢复任务负责补写 assistant transcript
```

---

## 11. 模块设计

# 11.1 IdentityResolver Lite

## 11.1.1 目标

任何进入 Runtime 的可处理事件，都能解析为 RuntimeActor。

即使用户没有绑定，也要生成稳定 guest identity。

---

## 11.1.2 P0 能力

```text
提取 PlatformIdentity
查找 identity_links
不存在则创建 guest identity
返回 RuntimeActor
提供 /whoami 调试命令
```

---

## 11.1.3 P0 暂不做

```text
多平台账号合并
复杂绑定码
历史迁移
身份合并回滚
OAuth
信任等级升级
```

---

## 11.1.4 guest identity 生成规则

```text
guest:${platform}:${provider}:${channelId}:${platformUserId}
```

示例：

```text
guest:onebot11:napcat:qq-local:123456
```

---

# 11.2 TranscriptStore

## 11.2.1 目标

保存被 Runtime 处理过的会话消息，用于最近历史回放。

P0 不把所有 transcript 都当作长期记忆。

---

## 11.2.2 保存范围

P0 保存：

```text
私聊中触发 Runtime 的用户消息
群聊中 @ bot / 命令 / 关键词触发的用户消息
成功发送的 assistant 回复
必要 command 结果
```

P0 默认不保存：

```text
群聊中未触发 bot 的普通消息
被过滤的系统事件
发送失败的 assistant 草稿
未授权工具结果
```

---

## 11.2.3 TranscriptStore 接口

```ts
interface TranscriptStore {
  appendIncoming(record: ConversationMessageRecord): Promise<void>;
  appendAssistant(record: ConversationMessageRecord): Promise<void>;
  listRecent(input: { sessionId: string; limit: number; maxChars: number }): Promise<ConversationMessageRecord[]>;
}
```

---

# 11.3 Workspace Lite

## 11.3.1 目标

P0 只区分 personal workspace、group workspace 和 system workspace。

Workspace 用于承载基础输出策略和上下文边界。

---

## 11.3.2 Workspace 类型

```ts
type WorkspaceType = "personal" | "group" | "system";
```

---

## 11.3.3 默认解析规则

| 事件来源  | Workspace                                                      |
| --------- | -------------------------------------------------------------- |
| QQ 私聊   | `personal:${actor.identity.id}`                                |
| QQ 群聊   | `group:${platform}:${provider}:${channelId}:${conversationId}` |
| CLI       | `personal:${actor.identity.id}`                                |
| Admin/TUI | `system:runtime-admin`                                         |

---

## 11.3.4 P0 不做 Project Workspace

以下命令只做预留，不执行真实切换：

```text
/workspace use project:synapse-runtime
```

P0 返回：

```text
当前版本暂不支持 project workspace。该能力计划在 P1 引入。
```

---

## 11.3.5 /workspace info

P0 支持：

```text
/workspace info
```

返回：

```text
当前 workspace:
- id
- type
- name
- sessionId
- output policy summary
```

---

# 11.4 ContextComposer Skeleton

## 11.4.1 目标

将一次事件合成为 Agent Provider 可消费的 PromptContext。

P0 只合成：

```text
Runtime base instruction
Actor summary
Workspace summary
OutputPolicy instruction
Recent session history
Current user input
```

---

## 11.4.2 P0 不合成

```text
durable memory
skill persona
workflow state
trigger context
vector retrieval
affective state
tool manifest 裁剪
```

---

## 11.4.3 输入

```ts
interface ContextComposeInput {
  event: SynapseChannelEvent;
  purpose: "agent" | "command";
  actor: RuntimeActor;
  workspace: WorkspaceContext;
  sessionId: string;
  includeHistory: boolean;
}
```

---

## 11.4.4 输出

```ts
interface RuntimeInvocationContext {
  invocationId: string;
  event: SynapseChannelEvent;
  actor: RuntimeActor;
  workspace: WorkspaceContext;
  outputPolicy: OutputPolicy;
  prompt: PromptContext;
}

interface PromptContext {
  systemInstructions: string[];
  developerInstructions: string[];
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  metadata: {
    actorId: string;
    workspaceId: string;
    sessionId: string;
    source: string;
  };
}
```

---

## 11.4.5 Prompt 合成顺序

```text
1. Runtime base instruction
2. Output policy instruction
3. Workspace instruction
4. Recent history
5. Current user message
```

---

## 11.4.6 Prompt 示例

```text
[Runtime]
你是 Synapse Runtime 中的助手。不要假装执行未执行的操作。

[Output Policy]
当前是 QQ 群聊。请简短回答，避免刷屏。需要长解释时先询问是否展开。

[Workspace]
当前 workspace 类型为 group。

[History]
最近几轮对话……

[Current Input]
用户当前消息……
```

---

## 11.4.7 失败降级

如果 ContextComposer 失败：

```text
1. 记录 error；
2. 不读取历史；
3. 降级为当前单轮 Agent.run；
4. 输出中不暴露内部错误。
```

---

# 11.5 ResponsePolicy

## 11.5.1 目标

统一控制 Agent 输出进入 Channel 前的长度、格式和刷屏风险。

---

## 11.5.2 默认策略

### 私聊

```ts
{
  style: "normal",
  maxChars: 2500,
  maxParagraphs: 10,
  allowMarkdown: true,
  allowCodeBlock: true,
  splitLongMessage: true,
  askBeforeLongAnswer: false,
  preferSummaryFirst: false
}
```

### 群聊

```ts
{
  style: "concise",
  maxChars: 600,
  maxParagraphs: 3,
  allowMarkdown: false,
  allowCodeBlock: false,
  splitLongMessage: false,
  askBeforeLongAnswer: true,
  preferSummaryFirst: true
}
```

### CLI / TUI

```ts
{
  style: "detailed",
  maxChars: 8000,
  maxParagraphs: 30,
  allowMarkdown: true,
  allowCodeBlock: true,
  splitLongMessage: false,
  askBeforeLongAnswer: false,
  preferSummaryFirst: true
}
```

---

## 11.5.3 P0 不做二次 LLM 压缩

P0 ResponsePolicy 不再次调用 LLM。

原因：

```text
避免链路复杂化
避免额外 token 成本
避免二次摘要改变原意
避免群聊响应延迟变高
```

---

## 11.5.4 群聊超长输出处理

群聊中，如果输出超过 `maxChars`：

```text
1. 预留提示语长度；
2. 在 maxChars - promptSuffix.length 内截断正文；
3. 优先截断到完整段落；
4. 如果没有完整段落，则硬截断；
5. 追加提示语；
6. 最终输出长度必须 <= maxChars。
```

默认提示语：

```text
内容较长，需要我展开再说。
```

---

## 11.5.5 Markdown 降级规则

当：

```text
allowMarkdown = false
```

ResponsePolicy 应执行：

```text
1. 移除 Markdown 标题标记 #；
2. 移除粗体 / 斜体标记；
3. 将列表符号简化为纯文本行；
4. 移除链接 markdown 语法，仅保留可读文本；
5. 移除表格结构，必要时转成短句。
```

P0 不要求完美 Markdown parser，可以做正则级降级。

---

## 11.5.6 CodeBlock 降级规则

当：

```text
allowCodeBlock = false
```

ResponsePolicy 应执行：

```text
1. 移除 fenced code block；
2. 如果代码块很短，可转成一句说明；
3. 如果代码块很长，替换为：
   “这里有一段代码，群聊里我先不展开。需要的话我可以继续发。”
4. 最终仍需满足 maxChars。
```

---

# 11.6 Durable Memory Lite，可选

## 11.6.1 定位

Durable Memory Lite 属于 P0d 可选能力。

默认关闭：

```toml
[memory]
enableDurableMemory = false
```

如果 P0d 不实现，不影响 P0a-c 上线。

---

## 11.6.2 P0d 允许写入的长期记忆

只允许以下内容进入 durable memory：

```text
用户显式表达的偏好
用户确认过的事实
明确的项目决策
命令式写入：/memory remember
系统规则生成的低风险摘要
```

---

## 11.6.3 P0d 禁止自动写入的内容

```text
模型推测
普通寒暄
群聊中的个人背景
未确认的临时状态
高敏感信息
工具原始输出
```

---

## 11.6.4 /memory remember

如果 `enableDurableMemory = false`：

```text
/memory remember ...
```

返回：

```text
当前未启用长期记忆。你的消息只会作为当前会话历史使用。
```

如果启用 P0d：

```text
/memory remember private 我喜欢简短回答
/memory remember group 本群默认短答
```

私聊可省略 scope，默认 private。

群聊可省略 scope，默认 group。

写入成功后必须明确提示：

```text
已记住为你的私人偏好。
```

或：

```text
已记住为本群设置。
```

---

## 12. 数据库 Schema

P0 使用 SQLite 作为本地事实源。

启动时必须启用：

```sql
PRAGMA foreign_keys = ON;
```

---

## 12.1 identities

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY,

  type TEXT NOT NULL
    CHECK(type IN ('guest', 'owner', 'system')),

  trust_level TEXT NOT NULL
    CHECK(trust_level IN ('guest', 'owner', 'system')),

  display_name TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 12.2 identity_links

```sql
CREATE TABLE identity_links (
  id TEXT PRIMARY KEY,

  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,

  identity_id TEXT NOT NULL,

  verified_at TEXT,
  verified_by TEXT,
  bind_method TEXT,

  revoked_at TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY(identity_id) REFERENCES identities(id)
);

CREATE UNIQUE INDEX idx_active_identity_link
ON identity_links(platform, provider, channel_id, platform_user_id)
WHERE revoked_at IS NULL;
```

---

## 12.3 conversation_messages

```sql
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,

  session_id TEXT NOT NULL,

  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  conversation_type TEXT NOT NULL
    CHECK(conversation_type IN ('private', 'group', 'cli', 'system')),

  conversation_id TEXT NOT NULL,

  platform_user_id TEXT,
  actor_id TEXT,

  role TEXT NOT NULL
    CHECK(role IN ('user', 'assistant', 'system', 'tool')),

  message_text TEXT,
  message_json TEXT,

  source_event_id TEXT,

  created_at TEXT NOT NULL,
  deleted_at TEXT,

  FOREIGN KEY(actor_id) REFERENCES identities(id)
);

CREATE INDEX idx_conv_session_created
ON conversation_messages(session_id, created_at DESC);

CREATE INDEX idx_conv_actor_created
ON conversation_messages(actor_id, created_at DESC);

CREATE UNIQUE INDEX idx_conv_source_event
ON conversation_messages(
  platform,
  provider,
  channel_id,
  conversation_type,
  conversation_id,
  source_event_id
)
WHERE source_event_id IS NOT NULL;
```

---

## 12.4 event_process_state

```sql
CREATE TABLE event_process_state (
  id TEXT PRIMARY KEY,

  platform TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  conversation_type TEXT NOT NULL
    CHECK(conversation_type IN ('private', 'group', 'cli', 'system')),

  conversation_id TEXT NOT NULL,

  source_event_id TEXT NOT NULL,

  status TEXT NOT NULL
    CHECK(status IN (
      'received',
      'processing',
      'agent_completed',
      'send_succeeded',
      'send_failed',
      'completed'
    )),

  incoming_message_id TEXT,
  assistant_message_id TEXT,

  agent_output_text TEXT,
  agent_output_json TEXT,

  send_result_json TEXT,
  error_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY(incoming_message_id) REFERENCES conversation_messages(id),
  FOREIGN KEY(assistant_message_id) REFERENCES conversation_messages(id)
);

CREATE UNIQUE INDEX idx_event_process_unique
ON event_process_state(
  platform,
  provider,
  channel_id,
  conversation_type,
  conversation_id,
  source_event_id
);
```

---

## 12.5 workspaces

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,

  type TEXT NOT NULL
    CHECK(type IN ('personal', 'group', 'system')),

  name TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 12.6 workspace_bindings

```sql
CREATE TABLE workspace_bindings (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  binding_type TEXT NOT NULL
    CHECK(binding_type IN ('identity', 'channel-conversation')),

  identity_id TEXT,

  platform TEXT,
  provider TEXT,
  channel_id TEXT,
  conversation_type TEXT,
  conversation_id TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY(identity_id) REFERENCES identities(id),

  CHECK (
    (
      binding_type = 'identity'
      AND identity_id IS NOT NULL
      AND platform IS NULL
      AND provider IS NULL
      AND channel_id IS NULL
      AND conversation_type IS NULL
      AND conversation_id IS NULL
    )
    OR
    (
      binding_type = 'channel-conversation'
      AND identity_id IS NULL
      AND platform IS NOT NULL
      AND provider IS NOT NULL
      AND channel_id IS NOT NULL
      AND conversation_type IS NOT NULL
      AND conversation_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX idx_workspace_binding_identity
ON workspace_bindings(workspace_id, identity_id)
WHERE binding_type = 'identity';

CREATE UNIQUE INDEX idx_workspace_binding_conversation
ON workspace_bindings(
  workspace_id,
  platform,
  provider,
  channel_id,
  conversation_type,
  conversation_id
)
WHERE binding_type = 'channel-conversation';
```

---

## 12.7 memory_records，可选

该表属于 P0d。

如果 P0d 不实现，可以不创建该表。

```sql
CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,

  scope_type TEXT NOT NULL
    CHECK(scope_type IN ('identity', 'workspace')),

  scope_id TEXT NOT NULL,

  owner_identity_id TEXT,
  workspace_id TEXT,

  visibility TEXT NOT NULL
    CHECK(visibility IN ('private', 'workspace', 'public', 'secret')),

  kind TEXT NOT NULL
    CHECK(kind IN ('preference', 'fact', 'decision', 'summary')),

  content_text TEXT NOT NULL,
  content_json TEXT,

  importance REAL NOT NULL DEFAULT 0.5
    CHECK(importance >= 0 AND importance <= 1),

  confidence REAL NOT NULL DEFAULT 0.8
    CHECK(confidence >= 0 AND confidence <= 1),

  pii_level TEXT NOT NULL DEFAULT 'none'
    CHECK(pii_level IN ('none', 'low', 'high')),

  prompt_eligible INTEGER NOT NULL DEFAULT 0
    CHECK(prompt_eligible IN (0, 1)),

  source_event_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,

  FOREIGN KEY(owner_identity_id) REFERENCES identities(id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX idx_memory_scope_created
ON memory_records(scope_type, scope_id, created_at DESC);

CREATE INDEX idx_memory_visibility
ON memory_records(visibility, owner_identity_id, workspace_id, deleted_at);
```

---

## 12.8 audit_events

```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,

  kind TEXT NOT NULL
    CHECK(kind IN (
      'identity.created',
      'identity.linked',
      'identity.unlinked',
      'transcript.created',
      'transcript.deleted',
      'memory.created',
      'memory.deleted',
      'context.compose_failed',
      'duplicate_event',
      'response.truncated',
      'send.failed'
    )),

  actor_id TEXT,
  workspace_id TEXT,

  event_json TEXT NOT NULL,

  created_at TEXT NOT NULL,

  FOREIGN KEY(actor_id) REFERENCES identities(id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);
```

---

## 13. Prompt Budget

## 13.1 为什么 P0 需要 Budget

P0 虽然只读取 recent history，但不能只按消息条数裁剪。

如果某条消息很长，20 条历史可能直接撑爆 prompt。

因此 P0 必须支持字符级预算。

---

## 13.2 默认 Budget

```text
private:
  maxHistoryMessages = 20
  maxHistoryChars = 12000

group:
  maxHistoryMessages = 8
  maxHistoryChars = 3000

cli:
  maxHistoryMessages = 30
  maxHistoryChars = 20000
```

---

## 13.3 裁剪规则

```text
1. 当前用户输入永远保留；
2. Runtime base instruction 永远保留；
3. OutputPolicy instruction 永远保留；
4. recent history 按时间从新到旧加入；
5. 超出 maxHistoryChars 时，从最旧历史开始丢弃；
6. P0 不做 LLM summarization；
7. P0 不做 history compression；
8. deleted_at 不为空的消息永不进入 prompt。
```

---

## 14. Recent History 查询规则

所有 recent history 查询必须过滤：

```sql
WHERE deleted_at IS NULL
```

示例：

```sql
SELECT *
FROM conversation_messages
WHERE session_id = ?
  AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT ?;
```

群聊 ContextComposer 只读取当前 group session 的 recent history。

私聊 ContextComposer 只读取当前 private session 的 recent history。

P0 不自动跨平台读取其他 session。

---

## 15. 群聊策略

## 15.1 响应条件

群聊默认只在以下情况响应：

```text
@ bot
回复 bot
命令前缀
配置关键词命中
```

---

## 15.2 保存策略

群聊默认只保存触发 Runtime 的消息。

不保存：

```text
未 @ bot 的普通聊天
无关群消息
被过滤的噪声消息
```

配置项：

```toml
[group]
saveUntriggeredMessages = false
```

---

## 15.3 上下文读取策略

群聊默认允许读取：

```text
当前 group session history
当前 group workspace 基础配置
```

群聊默认禁止读取：

```text
identity/private memory
其他 workspace memory
私聊 transcript
secret memory
其他 private session transcript
```

---

## 15.4 用户在群里问“我之前说的”

如果需要引用 private memory 或私聊历史，应回复：

```text
这个可能涉及你的私聊记忆，我不能在群里直接引用。你可以私聊我继续。
```

---

## 16. 配置项

```toml
[context]
enabled = true
fallbackToSingleTurn = true

[context.private]
maxHistoryMessages = 20
maxHistoryChars = 12000

[context.group]
maxHistoryMessages = 8
maxHistoryChars = 3000

[context.cli]
maxHistoryMessages = 30
maxHistoryChars = 20000

[context.idempotency]
enabled = true
processingTimeoutMs = 300000

[identity]
enabled = true
allowGuest = true

[memory]
driver = "sqlite"
databasePath = "./data/synapse-runtime.db"
enableDurableMemory = false
enableFts = false
enableVector = false

[response.private]
style = "normal"
maxChars = 2500
maxParagraphs = 10
allowMarkdown = true
allowCodeBlock = true
splitLongMessage = true

[response.group]
style = "concise"
maxChars = 600
maxParagraphs = 3
allowMarkdown = false
allowCodeBlock = false
askBeforeLongAnswer = true
splitLongMessage = false

[group]
saveUntriggeredMessages = false
allowPrivateMemoryInGroup = false
```

---

## 17. 与现有模块的集成

## 17.1 runtime-core

需要改造 `RuntimeCore.handleChannelEvent`。

目标链路：

```text
route
  ↓
identity resolve
  ↓
workspace resolve
  ↓
idempotency begin
  ↓
append incoming
  ↓
context compose
  ↓
agent run
  ↓
response policy
  ↓
send
  ↓
append assistant
  ↓
idempotency complete
```

---

## 17.2 conversation

保留 `ConversationRouter` 的响应判断职责。

它仍负责：

```text
是否响应
session key 基础推断
触发策略
mention / keyword / command 判断
```

但不负责：

```text
历史读取
记忆读取
人格合成
输出策略
身份解析
```

---

## 17.3 agent-core

Agent 接口建议演进为：

```ts
interface AgentInvocation {
  request: AgentRequest;
  context: RuntimeInvocationContext;
}
```

P0 可以通过 Legacy Adapter 兼容旧接口：

```ts
class LegacyAgentAdapter implements Agent {
  constructor(
    public readonly id: string,
    private readonly legacy: {
      run(request: AgentRequest, ctx: AgentRuntimeContext): Promise<AgentRun>;
    }
  ) {}

  run(invocation: AgentInvocation, runtime: AgentRuntimeContext) {
    return this.legacy.run(invocation.request, runtime);
  }
}
```

---

## 17.4 agent-api-provider

Provider 需要从 `PromptContext` 构造模型 messages。

P0 messages 来源：

```text
systemInstructions
developerInstructions
recent history
current user input
```

---

## 17.5 channel-onebot11 / channel-qq-official

Channel Adapter 需要尽量提供：

```text
platform
provider
channelId
conversationType
conversationId
platformUserId
sourceEventId
platformTimestamp
displayName
```

如果没有稳定 `sourceEventId`，Runtime 使用 best-effort 生成。

---

## 18. 实施计划

# 18.1 P0a：Identity + Transcript + Context Skeleton

## 范围

```text
IdentityResolver Lite
TranscriptStore
event_process_state
Recent History
ContextComposer Skeleton
```

## 关键任务

```text
1. 新增 SQLite migration runner；
2. 新增 identities / identity_links；
3. 新增 conversation_messages；
4. 新增 event_process_state；
5. 实现 PlatformIdentity 提取；
6. 实现 guest identity fallback；
7. 实现 TranscriptStore.appendIncoming / appendAssistant / listRecent；
8. 实现 sourceEventId 去重；
9. 实现 event_process_state 状态流转；
10. 实现 ContextComposer Skeleton；
11. 接入 runtime-core；
12. 保留 fallbackToSingleTurn。
```

## 验收

```text
同一 QQ 私聊用户第二轮问题能引用第一轮历史。
重复 sourceEventId 不重复调用 Agent。
ContextComposer 失败时仍可单轮回复。
```

---

# 18.2 P0b：ResponsePolicy + 群聊隔离

## 范围

```text
ResponsePolicy
群聊短答
规则截断
Markdown 降级
CodeBlock 降级
群聊未触发消息不保存
```

## 关键任务

```text
1. 实现 OutputPolicyResolver；
2. 实现 private/group/cli 默认策略；
3. 实现 maxChars 截断；
4. 实现 Markdown 降级；
5. 实现 CodeBlock 降级；
6. 确保群聊不二次 LLM；
7. 确保最终输出 <= maxChars；
8. 群聊未触发消息不写 transcript。
```

## 验收

```text
QQ群 @ bot 后回复不会超过 maxChars。
未 @ bot 群消息不进入 transcript。
群聊长代码块被替换为简短说明。
```

---

# 18.3 P0c：Workspace Lite

## 范围

```text
personal workspace
group workspace
system workspace
workspace_bindings
/workspace info
```

## 关键任务

```text
1. 新增 workspaces 表；
2. 新增 workspace_bindings 表；
3. 实现 WorkspaceResolver Lite；
4. 私聊解析为 personal workspace；
5. 群聊解析为 group workspace；
6. Admin/TUI 解析为 system workspace；
7. 实现 /workspace info；
8. project workspace 命令返回暂不支持。
```

## 验收

```text
私聊进入 personal workspace。
群聊进入 group workspace。
/workspace info 可查看当前 workspace。
/workspace use project:* 返回 P1 提示。
```

---

# 18.4 P0d：Durable Memory Lite，可选

## 范围

```text
memory_records
/memory remember
/memory list
/memory delete
ACL filter
```

## 默认

```text
enableDurableMemory = false
```

## 验收

```text
私聊 private memory 不进入群聊 prompt。
secret memory 永不进入 prompt。
deleted memory 不进入 prompt。
```

---

## 19. 验收标准

## 19.1 Identity

| 编号      | 验收用例                                                               |
| --------- | ---------------------------------------------------------------------- |
| AC-ID-001 | 给定同一 QQ 用户连续发送消息，IdentityResolver 返回相同 guest identity |
| AC-ID-002 | 给定未绑定用户，系统仍能正常进入 Agent 回复链路                        |
| AC-ID-003 | 给定 `/whoami`，系统返回当前 platform identity 与 synapse identity     |
| AC-ID-004 | IdentityResolver 失败时，Runtime 可降级为匿名单轮处理或拒绝高风险操作  |

---

## 19.2 Transcript

| 编号      | 验收用例                                                           |
| --------- | ------------------------------------------------------------------ |
| AC-TS-001 | 私聊用户发送消息并触发回复后，incoming 与 assistant reply 都被落盘 |
| AC-TS-002 | 同一 session 第二次提问时，ContextComposer 能读取第一次消息        |
| AC-TS-003 | 群聊未 @ bot 的消息默认不写入 transcript                           |
| AC-TS-004 | `deleted_at` 不为空的消息不会进入 prompt                           |
| AC-TS-005 | `listRecent` 本地 SQLite P95 < 50ms                                |
| AC-TS-006 | 给定相同 `source_event_id` 重复投递，TranscriptStore 不重复写入    |
| AC-TS-007 | 给定相同 `source_event_id` 重复投递，Runtime 不重复调用 Agent      |
| AC-TS-008 | `sendMessage` 失败时，不写 assistant transcript                    |

---

## 19.3 幂等

| 编号         | 验收用例                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| AC-IDEMP-001 | 同一 `sourceEventId` 首次处理到 `send_failed` 后，重复投递允许重试发送                 |
| AC-IDEMP-002 | 同一 `sourceEventId` 已 `completed` 后，重复投递不会再次调用 Agent 或发送消息          |
| AC-IDEMP-003 | 首次处理在 `processing` 状态崩溃，重启后可恢复或安全跳过，并记录 audit                 |
| AC-IDEMP-004 | `agent_completed` 状态下重复投递，不重新调用 Agent，复用已保存输出继续发送             |
| AC-IDEMP-005 | `send_succeeded` 但 assistant transcript 缺失时，重复投递只补写 transcript，不重复发送 |

---

## 19.4 Workspace

| 编号      | 验收用例                                      |
| --------- | --------------------------------------------- |
| AC-WS-001 | 私聊消息解析到 personal workspace             |
| AC-WS-002 | 群聊消息解析到 group workspace                |
| AC-WS-003 | group workspace 默认使用 concise 输出策略     |
| AC-WS-004 | personal workspace 默认使用 normal 输出策略   |
| AC-WS-005 | P0 不自动跨 workspace 检索记忆                |
| AC-WS-006 | `/workspace info` 返回当前 workspace 信息     |
| AC-WS-007 | `/workspace use project:*` 返回当前版本不支持 |

---

## 19.5 ContextComposer

| 编号      | 验收用例                                                     |
| --------- | ------------------------------------------------------------ |
| AC-CC-001 | 私聊第二轮 prompt 中包含上一轮 user/assistant history        |
| AC-CC-002 | 群聊 prompt 中最多包含最近 8 条相关 session history          |
| AC-CC-003 | ContextComposer 失败时，Runtime 降级为当前单轮回复           |
| AC-CC-004 | PromptContext metadata 包含 actorId、workspaceId、sessionId  |
| AC-CC-005 | 群聊 Prompt 中包含简短输出约束                               |
| AC-CC-006 | recent history 超过 `maxHistoryChars` 时，从最旧消息开始裁剪 |
| AC-CC-007 | 当前用户输入即使很长，也不会被 recent history 挤掉           |
| AC-CC-008 | `context.enabled = false` 时，Runtime 回退旧单轮链路         |

---

## 19.6 ResponsePolicy

| 编号      | 验收用例                                                                       |
| --------- | ------------------------------------------------------------------------------ |
| AC-RP-001 | 群聊输出超过 maxChars 时被规则截断                                             |
| AC-RP-002 | 群聊输出默认不包含大段 code block                                              |
| AC-RP-003 | 私聊允许较长回答                                                               |
| AC-RP-004 | ResponsePolicy 处理失败时，保守发送截断版                                      |
| AC-RP-005 | 群聊长回答末尾提示“内容较长，需要我展开再说。”                                 |
| AC-RP-006 | 群聊长回答不触发二次 LLM，只做规则截断                                         |
| AC-RP-007 | 群聊长回答截断后追加提示语                                                     |
| AC-RP-008 | 群聊中超长 code block 被移除或截断                                             |
| AC-RP-009 | ResponsePolicy 失败时，使用保守截断版                                          |
| AC-RP-010 | 群聊截断后，包含提示语的最终文本仍不超过 `maxChars`                            |
| AC-RP-011 | `allowMarkdown = false` 时，群聊输出不包含 Markdown 标题、粗体、链接或表格结构 |
| AC-RP-012 | `allowCodeBlock = false` 时，群聊输出不包含 fenced code block                  |
| AC-RP-013 | 群聊长代码块被替换为简短说明，且最终输出不超过 `maxChars`                      |

---

## 19.7 数据库

| 编号      | 验收用例                                                          |
| --------- | ----------------------------------------------------------------- |
| AC-DB-001 | `workspace_bindings` 不允许写入与 `binding_type` 不匹配的字段组合 |
| AC-DB-002 | 同一个 identity 不能重复绑定到同一个 workspace                    |
| AC-DB-003 | 同一个 channel conversation 不能重复绑定到同一个 workspace        |
| AC-DB-004 | recent history 查询必须过滤 `deleted_at IS NULL`                  |

---

## 19.8 安全

| 编号       | 验收用例                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ |
| AC-SEC-001 | 群聊 prompt snapshot 中不得出现 private memory 内容                                        |
| AC-SEC-002 | `allowPrivateMemoryInGroup = false` 时，任何 identity/private memory 都不进入 group prompt |
| AC-SEC-003 | 群聊未触发消息不写 transcript                                                              |
| AC-SEC-004 | `secret` memory 永不进入 prompt                                                            |
| AC-SEC-005 | `deleted_at` 不为空的 transcript / memory 永不进入 prompt                                  |
| AC-SEC-006 | 群聊 prompt 不包含 private transcript，也不包含 private memory                             |
| AC-SEC-007 | 群聊 ContextComposer 只读取当前 group session recent history                               |
| AC-SEC-008 | 私聊 ContextComposer 只读取当前 private session recent history，不自动读取其他平台 session |

---

## 19.9 Durable Memory，可选

| 编号       | 验收用例                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| AC-CFG-002 | `enableDurableMemory = false` 时，`/memory remember` 返回明确不可用提示         |
| AC-MEM-001 | 用户私聊执行 `/memory remember 我喜欢简短回答` 后，写入 identity/private memory |
| AC-MEM-002 | 群聊执行 `/memory remember 本群默认短答` 后，写入 group workspace memory        |
| AC-MEM-003 | private memory 不会进入群聊 prompt                                              |
| AC-MEM-004 | `deleted_at` 不为空的 memory 不会进入 prompt                                    |
| AC-MEM-005 | `secret` memory 永不进入 prompt                                                 |
| AC-MEM-006 | 私聊 `/memory remember` 默认写入 identity/private scope                         |
| AC-MEM-007 | 群聊 `/memory remember` 默认写入 workspace/group scope                          |
| AC-MEM-008 | 写入 memory 后回复必须说明记忆作用域                                            |

---

## 20. 测试计划

### 20.1 Unit Test

```text
IdentityResolver guest fallback
WorkspaceResolver private/group/system
TranscriptStore append/listRecent
event_process_state 状态流转
ResponsePolicy truncate
Markdown downgrade
CodeBlock downgrade
ContextComposer budget trim
```

---

### 20.2 Integration Test

```text
QQ 私聊两轮连续追问
QQ群 @ bot 短答
群聊未触发消息不保存
重复 sourceEventId 不重复调用 Agent
send_failed 后重复投递可重试
send_succeeded 但 transcript 缺失时可补写
ContextComposer 失败降级
```

---

### 20.3 Prompt Snapshot Test

保存不同场景下的 prompt 快照：

```text
private prompt
group prompt
cli prompt
context failure fallback prompt
memory disabled prompt
```

---

### 20.4 Privacy Regression Test

```text
private transcript 不进 group prompt
private memory 不进 group prompt
deleted transcript 不进 prompt
secret memory 不进 prompt
未触发群消息不保存
```

---

### 20.5 Migration Test

```text
空数据库启动
重复 migration
旧配置无 context 字段时正常启动
旧配置无 memory 字段时正常启动
foreign_keys 生效
CHECK 约束生效
```

---

## 21. 失败与降级策略

| 失败点                                 | 降级策略                                    |
| -------------------------------------- | ------------------------------------------- |
| SQLite 写入失败                        | 记录 error，继续单轮回复，但不使用历史      |
| IdentityResolver 失败                  | 降级 anonymous actor，禁止高风险能力        |
| WorkspaceResolver 失败                 | 降级 personal/group default workspace       |
| event_process_state 写入失败           | 记录 error，可继续但禁用幂等恢复            |
| ContextComposer 失败                   | 降级当前单轮 prompt                         |
| TranscriptStore 读取失败               | 不带历史，继续回复                          |
| ResponsePolicy 失败                    | 使用保守截断策略                            |
| Agent Provider 失败                    | 沿用当前错误处理                            |
| sendMessage 失败                       | 不写 assistant transcript，更新 send_failed |
| sendMessage 成功但 transcript 写入失败 | 更新 send_succeeded，后续补写               |

---

## 22. P1 / P2 路线图

### P1

```text
Project Workspace
Related Workspace 显式绑定
FTS5 memory retrieval
MemoryPromoter Lite
Prompt budget manager 增强
AgentInvocation 正式替换 legacy run
Skill Lite
ToolManifest 裁剪
```

---

### P2

```text
Vector retrieval
TriggerRuntime
WorkflowRuntime
主动输出上下文
Affective State
复杂用户绑定迁移
Plugin static registration
Admin/TUI memory viewer
多 Agent 协作
Planner
```

---

## 23. 最终开发前检查清单

进入 P0a-c 开发前必须确认：

```text
1. conversationId 使用纯平台目标 ID；
2. sessionId 使用 platform/provider/channelId/conversationType/conversationId；
3. sourceEventId 去重包含 conversationType 和 conversationId；
4. event_process_state 表存在；
5. sendMessage 成功后才写 assistant transcript；
6. send_succeeded 但 transcript 缺失时可补写；
7. workspace_bindings 有结构 CHECK；
8. recent history 查询过滤 deleted_at IS NULL；
9. group ResponsePolicy 截断后最终长度仍 <= maxChars；
10. P0 不做二次 LLM 压缩；
11. project workspace 不进入 P0 实现；
12. Durable Memory Lite 默认关闭；
13. ContextComposer 失败可降级旧单轮链路；
14. 重复 sourceEventId 不重复调用 Agent；
15. 群聊未触发消息不写 transcript。
```

---

## 24. 最终结论

P0 的交付承诺限定为：

```text
最近历史
身份识别
幂等处理
工作区边界
上下文合成
输出策略
安全降级
```

P0 不承诺：

```text
完整长期记忆
project workspace
主动触发
Workflow
Affective State
向量检索
复杂用户绑定
```

一句话总结：

> P0 先让 Synapse Runtime 的每一次回复变得“可识别、可追溯、可恢复、可控长短、可安全降级”；长期记忆、项目空间、主动智能和工作流进入下一阶段。
