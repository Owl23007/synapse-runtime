# Synapse Runtime Channel 输入输出调研与协议建模 PRD

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 项目名称 | Synapse Runtime |
| 需求名称 | Channel 输入输出能力调研与协议建模 |
| 文档版本 | v0.1 |
| 优先级 | P0 |
| 目标迭代 | 下一迭代 |
| 当前状态 | 待评审 |
| 主要范围 | OneBot11/NapCat、QQ Official、CLI |
| 后续依赖 | 全量消息落库、上下文恢复、Agent Loop、表情与 Reaction 回复 |

## 2. 背景

Synapse Runtime 当前已经支持 OneBot11/NapCat、QQ Official 和 CLI 等不同 Channel，并能够完成消息接收、上下文构建、模型调用和平台回复。

但现有 Channel 输入输出模型主要围绕文本消息和当前业务需求逐步演进，存在以下问题：

1. 不同 Channel 输出给 Runtime 的消息结构不够统一。
2. 部分平台特性可能在规范化过程中丢失，例如平台表情、贴纸、消息段顺序、引用关系和平台扩展字段。
3. 输入消息可能被提前压缩为纯文本，导致后续无法准确恢复原始语义。
4. Runtime 向平台发送消息时，缺少统一的平台输出动作模型。
5. 当前缺少对各平台输入、输出 API 的系统性实测，已有设计较多依赖 API 文档和代码假设。
6. 不同 Channel 的能力差异、约束条件和降级策略尚未形成明确模型。
7. 在消息协议尚未稳定前直接进行全量落库，可能导致数据库模型反过来限制消息表达能力。

Synapse Runtime 后续计划支持：

- 所有有对话意义的消息全量落库；
- 群聊普通消息上下文恢复；
- 平台表情和贴纸理解；
- 使用表情、贴纸或 Reaction 回复用户；
- 消息编辑、撤回和引用关系；
- 跨 Channel 的统一 Agent 行为；
- 历史消息重新规范化和重放。

因此，需要先建立可靠的 Channel 输入输出事实依据，并在此基础上完成统一协议建模。

## 3. 问题定义

当前需要解决的核心问题不是“如何保存消息”，而是：

> Synapse Runtime 应如何在不丢失平台特色的前提下，统一描述平台已经发生的事件，以及 Runtime 希望平台执行的操作？

本迭代需要回答以下问题：

1. 当前各 Channel 实际支持哪些输入事件和输出操作？
2. API 文档描述与真实运行行为是否一致？
3. 不同平台如何表达文本、表情、贴纸、图片、引用和 Reaction？
4. 哪些语义可以进入公共协议，哪些应保留为平台扩展？
5. 无法识别或暂不支持的消息类型如何避免被静默丢弃？
6. 输入与输出应共享哪些内容结构，又应在哪些层面保持区分？
7. Channel 应如何声明自身能力和限制？
8. 后续全量落库应保存什么协议对象？

## 4. 产品目标

### 4.1 总体目标

建立一套经过真实 API 验证、能够保留平台特色、支持长期演进的 Synapse Channel 输入输出协议。

本迭代分为两个相互依赖的工作流：

### 4.2 工作流 A：Channel API 能力调研与实测

系统调查并尽可能亲自测试当前 Channel 的输入和输出 API，形成可验证的事实依据。

### 4.3 工作流 B：基于证据的 Channel Protocol 建模

根据 API 文档、真实测试结果和 Synapse Runtime 的业务需求，建立统一输入事件、输出动作、消息内容和能力描述模型。

## 5. 成功标准

1. OneBot11/NapCat、QQ Official 和 CLI 的 P0 输入输出能力均有明确调查结论。
2. P0 能力具有脱敏后的真实请求、响应或事件 Fixture。
3. API 文档与真实行为的差异得到记录。
4. 所有已测试的消息类型都能被统一协议表达。
5. 表情、贴纸、图片、引用和消息段顺序不会被压缩为不可恢复的纯文本。
6. 不认识的消息类型不会被静默丢弃。
7. Runtime 可以使用统一动作模型向不同平台发送消息。
8. Channel 能够明确声明支持、部分支持、不支持或尚未验证的能力。
9. 协议模型可以稳定序列化并带有版本信息。
10. 后续数据库模型可以从该协议反推，而不需要重新设计消息语义。

## 6. 非目标

本迭代不包含：

1. 所有消息的正式全量数据库落库。
2. Agent Loop、Task Runtime 或后台任务。
3. 长期记忆、Session 主线与支线。
4. 完整的 Event Sourcing 或通用 EventBus。
5. 群管理、成员管理、好友管理等平台管理能力。
6. 立即支持所有平台特色消息的发送。
7. 复杂的跨平台消息自动降级策略。
8. 字节级还原原始平台 Payload。
9. 统一自然人身份模型。
10. 图片理解、语音识别或表情情感分析。

## 7. 范围定义

### 7.1 当前 Channel

| Channel | 类型 | 优先级 |
| --- | --- | --- |
| OneBot11 / NapCat | QQ 非官方接入 | P0 |
| QQ Official | QQ 官方机器人 | P0 |
| CLI | 本地终端交互 | P0 |

未来可以扩展 Discord、Slack、Telegram、Web Chat、HTTP/Webhook 等 Channel，但不属于本迭代交付范围。当前协议不得阻止其后续接入。

### 7.2 API 调查范围

“全部功能”在本 PRD 中限定为：

> 与消息接收、消息发送和消息关联交互直接相关的全部可用 API。

包括消息接收、发送、回复、Mention、Reaction、编辑、撤回、附件、富消息、平台表情与贴纸、消息 ID、发送结果、错误、限制和重试行为。

不包括群管理、好友管理、权限管理、账号管理等与消息通信无关的平台后台 API。

## 8. 核心原则

### 8.1 规范化不等于抹平差异

统一协议应提供稳定公共语义，同时允许平台特性继续存在：

```text
统一公共语义
+ 命名空间化平台扩展
+ 可追溯原始 Payload
```

### 8.2 禁止静默丢失

任何无法识别的消息事件或消息段必须转换为 Unknown 类型，或明确记录规范化失败，不得直接过滤或忽略。

### 8.3 保留消息内容顺序

混合消息的消息段顺序必须与平台输入保持一致。文本、Mention、表情、图片等内容不能只保存为拼接后的纯文本。

### 8.4 输入是事实，输出是动作

Channel 输入描述平台已经发生的事实；Channel 输出描述 Runtime 希望平台执行的操作。两者可以共享消息内容模型，但不能共用模糊的顶层 Message 对象。

### 8.5 文档不能代替实测

协议模型必须同时参考官方 API 文档、实际运行结果和当前 Synapse Runtime 使用需求。当文档与实测冲突时，优先兼容真实运行行为，同时记录差异。

### 8.6 存储模型后置

本迭代先稳定协议和测试 Fixture，再设计正式数据库模型。

## 9. 目标使用者

- Runtime 维护者：了解各 Channel 支持的能力及其差异原因。
- Channel Adapter 开发者：明确 Adapter 的输入、输出、保真和能力声明契约。
- Runtime Core 开发者：基于统一协议实现消息持久化、决策、上下文和平台输出。
- 后续功能开发者：基于稳定消息模型实现表情回复、Reaction、消息恢复和多模态上下文。

## 10. 工作流 A：Channel API 能力调研与实测

### 10.1 目标

系统梳理并实测各 Channel 的消息输入和平台输出能力，形成能力矩阵、真实 Fixture 和差异报告。

### 10.2 输入能力调查

P0 必须调查并尽可能实测：

| 类别 | 能力 |
| --- | --- |
| 基础消息 | 纯文本 |
| 文本特性 | Unicode Emoji、换行、空白、特殊字符 |
| 平台表情 | QQ 原生表情、商城表情或其他平台表情 |
| 贴纸 | Sticker、大表情、表情包 |
| 引用 | 回复消息、引用消息 ID、引用内容 |
| Mention | @bot、@用户、@全体 |
| 媒体 | 图片、语音、视频 |
| 文件 | 普通文件、附件元数据 |
| 混合消息 | 多消息段及顺序 |
| 富内容 | JSON、Markdown、卡片、合并转发 |
| 身份信息 | sender ID、nick、card、role |
| 会话信息 | 私聊、群聊、频道 |
| 状态变化 | 消息撤回、删除、编辑 |
| 轻交互 | Reaction、戳一戳等平台事件 |
| 异常情况 | 未知消息段、缺失字段、重复推送、乱序 |

每项至少记录平台原始事件结构、必填和可选字段、外部事件和消息 ID、时间、消息段顺序、sender、conversation、平台扩展字段、重复推送及异常表现。

### 10.3 输出能力调查

P0 必须调查并尽可能实测：

| 类别 | 能力 |
| --- | --- |
| 基础发送 | 发送纯文本 |
| 文本特性 | Unicode Emoji、换行、特殊字符 |
| 平台表情 | 发送平台原生表情 |
| 贴纸 | 发送贴纸或表情包 |
| Mention | @指定用户 |
| 回复 | 原生回复、引用回复 |
| 媒体 | 发送图片、语音、视频 |
| 文件 | 发送普通文件 |
| 混合消息 | 发送多个有序消息段 |
| 富内容 | Markdown、卡片、JSON 等 |
| Reaction | 添加、移除 Reaction |
| 消息管理 | 编辑、撤回 Bot 消息 |
| 返回结果 | 外部消息 ID、发送时间、平台响应 |
| 错误行为 | 权限不足、窗口过期、频率限制 |
| 重试行为 | 重复提交、超时和重试结果 |

QQ Official 重点验证主动消息与被动回复差异、回复窗口、关联字段、过期错误和消息类型限制。

OneBot11/NapCat 重点验证消息段格式、平台表情、商城表情、贴纸、引用、合并转发、撤回、外部消息 ID 及扩展字段差异。

CLI 重点验证纯文本、Unicode Emoji、特殊字符、多行输入以及不支持能力的明确声明。

### 10.4 调查状态

| 状态 | 含义 |
| --- | --- |
| documented | 文档明确描述，但尚未实测 |
| tested-supported | 已实测并支持 |
| tested-partial | 已实测但存在限制 |
| tested-unsupported | 已实测且不支持 |
| unstable | 测试结果不稳定 |
| blocked | 当前环境无法测试 |
| unknown | 尚未调查 |

禁止把“尚未测试”直接写成“不支持”。

### 10.5 Fixture 要求

所有实测数据应保存为脱敏 Fixture：

```text
fixtures/
  onebot11/
    inbound/
    outbound/
    errors/
  qq-official/
    inbound/
    outbound/
    errors/
  cli/
    inbound/
    outbound/
```

每个场景至少保存输入原始 Payload、输出请求、输出响应、能力名称、测试环境、测试结论和脱敏说明。

Fixture 不得包含真实 Access Token、私密密钥、不必要的用户隐私或可直接定位真实用户的聊天内容。

### 10.6 测试脚本

应提供可重复运行的测试工具或脚本，支持：

- 主动发送指定消息类型；
- 记录平台请求和响应；
- 捕获入站事件；
- 导出脱敏 Fixture；
- 标记测试场景；
- 对比重复测试结果。

测试脚本应尽量与生产 Adapter 解耦，避免测试逻辑污染运行时代码。

### 10.7 工作流 A 交付物

1. Channel API 文档索引。
2. 输入、输出能力矩阵。
3. 真实脱敏 Fixture。
4. API 实测脚本。
5. 文档与实际行为差异报告。
6. 未验证能力清单。
7. 平台限制和错误码清单。
8. 初步语义映射表。

## 11. 工作流 B：Channel Protocol 建模

### 11.1 目标

基于工作流 A 的调查结果，建立平台无关但可保留平台特色的 Channel 输入输出协议。

### 11.2 协议分层

```text
平台原始 Payload
        ↓
Channel Adapter
        ↓
统一 Channel 输入事件
        ↓
Runtime
        ↓
统一 Channel 输出动作
        ↓
Channel Adapter
        ↓
平台 API
```

- 原始 Payload 用于排错、重放、重新规范化和保留暂时无法理解的信息。
- Channel 输入事件描述平台已经发生的事实。
- Channel 输出动作描述 Runtime 请求平台执行的操作。
- Channel 执行结果描述输出动作的实际结果。

### 11.3 输入事件模型

第一版至少支持：

| 事件 | 说明 |
| --- | --- |
| `message.created` | 收到新消息 |
| `message.updated` | 消息发生编辑 |
| `message.deleted` | 消息被删除或撤回 |
| `reaction.added` | 某条消息新增 Reaction |
| `reaction.removed` | 某条消息移除 Reaction |
| `unknown` | 暂时无法识别的事件 |

输入事件必须包含 Schema 版本、Channel 和平台标识、Adapter 类型、外部事件 ID、发生和接收时间、conversation 和 actor 引用、事件具体内容以及命名空间化扩展字段。

### 11.4 输出动作模型

第一版至少支持：

| 动作 | 说明 |
| --- | --- |
| `message.send` | 向平台发送消息 |
| `message.edit` | 编辑已发送消息 |
| `message.delete` | 删除或撤回消息 |
| `reaction.add` | 添加 Reaction |
| `reaction.remove` | 移除 Reaction |

输出动作必须包含动作 ID、目标 Channel、目标 conversation、消息或操作内容、引用目标、调用约束以及可选幂等键。

### 11.5 消息内容模型

输入和输出共享统一的、有序消息内容表达。第一版消息段至少包括：

| 消息段 | 说明 |
| --- | --- |
| `text` | 普通文本和 Unicode Emoji |
| `mention` | @用户、@bot、@全体 |
| `emoji` | 平台原生或自定义表情 |
| `sticker` | 贴纸、大表情或表情包 |
| `image` | 图片 |
| `audio` | 语音或音频 |
| `video` | 视频 |
| `file` | 文件 |
| `reference` | 回复、引用或关联消息 |
| `rich-content` | Markdown、卡片、JSON 等富内容 |
| `unknown` | 暂时无法识别的消息段 |

内容模型必须满足：

1. 保留消息段原始顺序。
2. `plainText` 只能作为派生文本。
3. Unicode Emoji 默认保留在文本中。
4. 平台表情必须保留平台命名空间和外部 ID。
5. Sticker 与普通 Emoji 分开表达。
6. 图片、文件等内容保留资源引用和元数据。
7. 未知消息段保存原始类型和 Payload。
8. 平台扩展字段使用命名空间隔离。

### 11.6 表情模型要求

- Unicode Emoji 保留在原始文本中，第一版无需拆成独立消息段。
- 平台表情必须包含 namespace、外部 ID、名称或替代文本、是否动态及可选资源引用。
- Sticker 必须独立于 Emoji 建模，并支持 sticker ID、pack ID、名称、动画状态、资源引用和替代文本。

### 11.7 Reply 与 Reaction 的边界

Reply 属于消息间的引用关系，应保留被引用消息外部 ID、conversation、平台提供的引用内容以及内部消息映射状态。

Reaction 不属于普通消息内容，必须作为独立输入事件和输出动作表达，不能强制转换为文本消息。

### 11.8 Actor 与 Conversation 引用

Channel 协议使用平台外部引用，不直接依赖数据库内部 ID。

Actor 引用至少包含平台、Channel、外部 Actor ID，以及可选昵称、群名片、角色和发送时快照。

Conversation 引用至少包含平台、Channel、外部 Conversation ID、类型、可选父级 conversation 和标题。同一平台绑定多个机器人账号时，不得仅使用平台 ID 作为唯一标识。

### 11.9 Unknown 模型

必须提供 Unknown Event 和 Unknown Message Part，并至少保留原始类型、原始顺序、fallback 文本、原始 Payload 和所属平台命名空间。

### 11.10 Channel Capability 模型

| 状态 | 含义 |
| --- | --- |
| supported | 完整支持 |
| partially-supported | 有条件支持 |
| unsupported | 不支持 |
| unknown | 尚未验证 |

部分支持必须能够描述被动回复窗口、回复对象限制、表情类型、混合消息、附件大小、主动/被动消息、编辑和 Reaction 限制等约束。Capability 必须来源于调查结果，不能由当前代码默认值推断。

### 11.11 Channel 输出结果

平台输出操作必须返回标准结果，至少包括状态、外部消息 ID、平台执行时间、错误码、错误信息、是否可重试、平台原始响应和扩展字段。

发送成功后必须保留外部消息 ID，以支持 `reply_to_bot`、编辑、撤回、Reaction 和出站消息落库。

## 12. 契约测试

### 12.1 入站契约测试

```text
Raw Platform Payload
        ↓
Adapter Normalize
        ↓
Expected Channel Inbound Event
```

至少验证消息段和顺序、外部 ID、actor、conversation、Reply、表情、Sticker、Unknown 内容和扩展字段命名空间。

### 12.2 出站契约测试

```text
Channel Outbound Action
        ↓
Adapter Encode
        ↓
Expected Platform Request
```

至少验证文本、消息段顺序、Mention、Reply、平台表情 ID、不支持能力的明确错误，以及 Adapter 不进行未声明的隐式降级。

### 12.3 双向语义测试

对于平台支持双向表达的内容，应验证：

```text
平台输入 → 统一协议 → 平台输出
```

不要求原始 Payload 字节一致，但必须保证表情、Mention 目标、Reply 关系、消息段顺序和资源引用等重要语义不变。无法重新发送时必须明确报告 `unsupported`。

## 13. 功能需求清单

### P0

- 完成当前三个 Channel 的能力清单。
- 建立 Fixture 目录与脱敏规范。
- 完成文本、Emoji、平台表情、Mention、Reply、图片和混合消息输入实测。
- 完成文本、表情、Mention、Reply 和图片发送实测。
- 建立输入事件、输出动作、统一消息内容、Unknown、Capability 和标准输出结果模型。
- 为所有 P0 Fixture 增加契约测试。
- 记录 API 文档与实际行为差异。

### P1

- Sticker 和表情包。
- 文件、语音、视频。
- Reaction。
- 编辑和撤回。
- 富文本、卡片和合并转发。
- 重复推送、幂等、频率限制和重试测试。
- 双向语义回放测试。

### P2

- 自动 Fixture 导出工具。
- Capability 自动探测。
- 跨平台输出降级策略。
- 平台协议版本兼容层。
- 新 Channel Adapter 接入模板。

## 14. 非功能需求

### 14.1 可扩展性

新增消息段类型时不应要求修改所有 Channel；新增 Channel 时不应修改 Runtime 的平台相关业务逻辑。

### 14.2 向后兼容

所有协议对象必须包含 Schema 版本。新增可选字段不得破坏旧数据解析。

### 14.3 可观测性

规范化失败、输出失败和不支持能力必须记录 Channel、事件或动作类型、外部 ID、错误原因、Schema 版本和 Adapter 版本。

### 14.4 安全性

Fixture 和日志必须脱敏；原始 Payload 不得泄露 Access Token、密钥和敏感认证信息。

### 14.5 可测试性

Normalizer 和 Encoder 必须可脱离真实网络测试。真实 API 测试和协议契约测试应相互独立。

## 15. 技术与产品边界

### 15.1 Channel Adapter 负责

- 接收平台事件并转换为统一输入协议。
- 将统一输出动作转换为平台请求。
- 保留平台扩展字段。
- 声明 Channel Capability。
- 返回平台执行结果。

### 15.2 Channel Adapter 不负责

- 判断是否回复、构建上下文或选择模型。
- 决定回复内容或创建 Session、Task。
- 保存 Runtime 业务实体。
- 自动选择跨平台降级策略。
- 解释表情的情感含义。

### 15.3 Runtime 负责

- 消费统一输入事件。
- 根据能力规划平台输出。
- 决定是否回复并构建上下文。
- 调用 Agent 并产生统一输出动作。
- 记录执行结果。

## 16. 实施阶段

### 阶段一：调查基础设施

交付能力清单、Fixture 目录、脱敏规则、测试环境、测试记录模板和 API 文档索引。

### 阶段二：P0 API 实测

交付三个 Channel 的 P0 输入输出 Fixture、能力矩阵和文档差异记录。

### 阶段三：协议 v0

交付 Channel 输入事件、输出动作、MessageContent、MessagePart、ActorRef、ConversationRef、Capability、ActionResult 和 Schema 版本规则。

### 阶段四：Adapter 契约测试

交付入站和出站 Golden Tests、Unknown 类型、消息段顺序、平台表情、Reply 和 Mention 测试。

### 阶段五：协议评审与冻结

交付 Channel Protocol v1 草案、已知限制、延后能力、后续落库模型输入和 Adapter 迁移计划。

## 17. 验收标准

### 17.1 调研验收

1. 每个 P0 能力具有明确状态。
2. 已实测能力具有真实脱敏 Fixture。
3. 未测试能力明确标记为 `blocked`、`unknown` 或 `documented`。
4. 文档与实测差异有独立记录。
5. 各平台输入输出限制有明确说明。
6. 输出 API 成功时能够获取平台返回结果。
7. 错误、权限和时间窗口至少完成基础验证。

### 17.2 建模验收

1. 所有 P0 Fixture 都能够被统一协议表达。
2. 不存在静默丢弃消息段的代码路径。
3. 混合消息顺序保持不变。
4. 平台表情和 Sticker 不被简单压缩成纯文本。
5. Unknown Event 和 Unknown Part 可序列化。
6. 输入事件与输出动作顶层模型明确分离。
7. MessageContent 可在输入和输出中复用。
8. Capability 与实测结果一致。
9. 不支持能力能够返回明确结果。
10. 每个协议对象具有 Schema 版本。
11. 新增平台扩展字段不要求修改公共核心字段。
12. 契约测试可以在没有真实平台连接时运行。

## 18. 风险与应对

| 风险 | 应对措施 |
| --- | --- |
| 平台文档与真实行为不一致 | 保存真实 Fixture，将差异纳入测试，避免依赖未验证字段 |
| 无法测试全部 API | 区分 documented、tested、blocked 和 unknown，不将未测试标记为不支持 |
| 协议过度追求平台无关 | 保留命名空间扩展、Unknown 类型和原始 Payload |
| 协议过度平台化 | 公共字段只表达稳定语义，Runtime Core 不依赖平台字段名 |
| 调研范围失控 | 限定消息输入输出 API，P0 优先覆盖当前 Runtime 所需能力 |
| 测试数据泄露 | 建立脱敏规范，提交前扫描 Token 和敏感字段，不保存真实私聊内容 |

## 19. 后续演进

```text
Channel Protocol 稳定
        ↓
原始事件与规范化消息全量落库
        ↓
Runtime 只处理已持久化消息
        ↓
ConversationDecision 与上下文恢复
        ↓
Agent Loop 和工具调用
        ↓
表情、Sticker 与 Reaction 回复
        ↓
Workspace、Task 和长期记忆
```

下一阶段数据库预计需要承载 Raw Channel Event、Canonical Inbound Event、Canonical Message、Outbound Action、Channel Action Result、外部消息 ID 映射、Actor 和 Conversation 引用。

具体存储表结构不在本 PRD 范围内，应在协议 v1 稳定后单独设计。

## 20. 最终交付定义

本迭代完成的最终标志不是“写出一套 TypeScript 类型”，而是形成以下闭环：

```text
真实平台 API
        ↓
可重复实测
        ↓
脱敏 Fixture
        ↓
统一协议
        ↓
Adapter 契约测试
        ↓
真实平台回归验证
```

最终交付：

1. Channel 输入输出能力矩阵。
2. API 文档索引与差异报告。
3. 可重复运行的 API 实测脚本。
4. 脱敏真实 Fixture。
5. Channel Protocol v1。
6. Adapter 入站和出站契约测试。
7. Capability 模型。
8. 已知限制与后续计划。
9. 下一阶段全量落库设计的输入依据。
