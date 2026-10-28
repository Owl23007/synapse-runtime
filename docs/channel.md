# Channel 原生能力与平台适配

Channel 是平台接入原生模型的 adapter。原生协议由 Runtime 自己定义，包含完整的消息、资源、交互与管理能力；某个平台不支持某个功能，不应删掉原生功能。WebUI 等自有入口以后可以直接消费同一套原生动作、事件和资源结果，不需要伪装成 QQ，也不需要另建一套聊天协议。

这里的“能力全集”指 `@synapse/runtime-protocol` 中定义的完整领域契约及其统一分发通路，不表示已经提供原生聊天数据库、全部业务用例或 WebUI 聊天接口。也不意味着每个平台 adapter 已实现文档中所有接口。平台声明、平台文档、账号权限与原生协议分别负责不同的事情。

## 职责与边界

| 层次               | 职责                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `runtime-protocol` | 定义原生实体、内容片段、事件、动作、资源结果和能力目录，不依赖平台实现           |
| `runtime-channel`  | 规范生命周期、能力投影和动作分发；检查版本、归属、目标、内容及大小限制           |
| 平台 adapter       | 将已实现的能力映射到平台 API，归一化平台事件和错误，保留无法通用化的命名空间扩展 |
| Runtime 与接入服务 | 确认身份与权限，管理持久化、幂等、路由、审计、恢复及交付策略                     |
| WebUI 等客户端     | 展示原生事件和资源，提交原生动作；不持有平台凭据，不直接调用平台 API             |

`CHANNEL_NATIVE_ACTIONS` 是原生动作目录，`CHANNEL_NATIVE_MESSAGE_SEGMENTS` 是内容全集。目录本身不授予权限。`createChannelCapabilityProfile` 将 adapter 的已实现子集投影到完整目录：未映射项明确返回 `unsupported`。新增标准动作必须进入原生目录，不能因为现有 QQ 接口没有对应功能而无法建模。

## 原生能力

| 领域     | 原生表达                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 消息     | 发送、编辑、删除、读取、历史列表、转发、置顶、取消置顶、标记已读、流式更新                                                               |
| 内容     | text、mention、reply、image、file、audio、video、emoji、sticker、reference、rich-content、unknown；消息另含 button/select/input 交互组件 |
| 表情回应 | reaction.add / reaction.remove，与消息正文中的 emoji 区分                                                                                |
| 文件     | 上传、读取引用、列表、删除；上传目标包含 private/group/channel，内容使用字节，不使用只在 Runtime 宿主可见的路径                          |
| 会话     | 读取、列表、创建、更新、离开                                                                                                             |
| 成员     | 读取、列表、更新昵称/角色/禁言截止时间、移除                                                                                             |
| 交互     | interaction.respond；typing.set 是独立短暂信号                                                                                           |
| 资源结果 | 类型明确的 message/messages、file/files、conversation/conversations、member/members；列表含不透明 nextCursor                             |
| 扩展     | `platform.execute` 必须使用 `provider:capability`，独立声明能力并提供执行入口                                                            |

`channelAction` 为所有动作补齐 schemaVersion 与 createdAt，现有 `messageSendAction`、`groupFileUploadAction` 保持兼容。原生文件上传使用 `ChannelFileUpload`；原有 `GroupFileUpload` 只是兼容名称，不再代表原生文件模型只能用于群聊。

原生资源结果保留稳定 ID；临时 URL、平台文件上传票据及下载过期时间不应混为同一个标识。文件删除与消息删除分别处理。会话与成员动作中的目标指向实际资源所属范围，不能拿平台 QQ 号代替官方 OpenID。

非消息事件通过 `resource` 携带原生实体或资源引用，无需伪造空消息。`origin` 区分 incoming、outgoing、history；平台自发消息与历史补录可用于记录，但不再次触发智能体。外部事件 ID、消息 ID、会话 ID 与 Runtime 数据库 ID 分开使用。

## 执行与能力约束

调用方通过 `executeChannelAction` 分发动作。adapter 可实现通用 `executeAction` 接受完整原生判别联合，未来原生服务或 WebUI 入口不受旧执行器只支持发送与群文件的限制。旧的 sendMessage/uploadGroupFile 方法保留兼容；平台扩展只走 `executePlatformAction`，不能借通用原生入口绕过独立能力声明。

支持状态为 supported、partially-supported、unsupported、unknown。未实现和未声明的动作不会向平台发请求。能力约束包括目标种类、片段、Markdown 等富内容格式、提及种类、交互组件、文件大小以及各目标的额外限制。全局约束和 perTarget 约束同时生效，编辑及流式更新也需要检查内容，不能只校验首次发送。

adapter 的声明指向实际映射实现。文档中有某个 API，不等于当前 adapter 已实现它，更不等于当前账号已获得资格。`source=documented` 只说明映射依据来自官方文档，不是在线验证标记。Admin 的 channel 摘要暴露当前实例的完整能力投影，后续客户端可读取，不应根据平台名称猜测是否支持某个动作。

`replyTo` 默认是可选的交付上下文，兼容现有 Runtime 补充回复线索的行为。若调用方要求必须保留该上下文，设置 `required=true`；无法映射时应拒绝。正文中的显式 reply/reference 片段是内容本身，不能作为可选提示悄悄丢弃。

| 结果        | 原生语义                                                 |
| ----------- | -------------------------------------------------------- |
| succeeded   | 收到该动作要求的成功回执；发送回执不代表用户已读         |
| failed      | 发送前失败或平台明确拒绝；平台诊断正文不能直接进入回执   |
| unsupported | 当前 adapter 无法无损映射该动作、目标或内容              |
| uncertain   | 提交后无法确定平台终态，可能已经产生副作用，不能自动重发 |

`platformReceipt` 仅携带安全的平台 code 和 HTTP 状态，资源查询结果放在 `data`。权限不由能力声明代替，恢复策略也不由 adapter 承担。复合操作只要已有部分副作用，就不能简单转成可重试失败；未实现的片段不能悄悄删掉，未知内容不能直接变成平台指令。

## 当前平台映射

### OneBot11 / NapCat

依据 [OneBot11 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)、[消息片段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md) 与 [NapCat API](https://napneko.github.io/onebot/api)。

- 消息发送映射 send_msg，显式 reply 片段或 required=true 的 replyTo 映射 CQ reply，可选回复线索不强制改变既有消息展示。普通文本转义 CQ 特殊字符，只有相应原生片段或明确要求的回复关系能够生成平台指令
- message.delete 映射 delete_msg，message.get 映射 get_msg；撤回时限与权限由平台校验，读取结果返回原生消息资源
- file.upload 根据目标映射 NapCat 的 upload_private_file 或 upload_group_file，使用 base64 内容传输；这属于 NapCat 扩展实现，不冒充 OneBot11 原生文件 API
- 当前发送编码器支持 text/mention/reply/image，NapCat 组合文件交付另外支持 file。其他片段继续存在于原生模型中，但当前出站映射明确拒绝
- message_sent 归一化为 outgoing；未知入站片段保留 namespace/rawType/fallbackText/raw。平台回显的错误正文不直接进入操作结果

### QQ 官方

依据 [访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[单聊撤回](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html)、[群聊撤回](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html)。

- 官方当前统一域名是 api.bot.qq.com，已导出对应统一端点常量。既有默认网关为兼容部署保留，新部署通过 apiBaseUrl/tokenEndpoint 显式选择统一域名。凭据及 access_token 只在服务端使用
- HTTP 成功与业务 code 分别判断。令牌缓存使用实际剩余有效期；发送缺少 message ID 时不能确认交付
- 当前发送映射支持文本、单个纯 Markdown 内容、被动回复上下文和显式 reference。私聊/群聊不伪造 mention；频道只支持有目标账号的提及。混合媒体和交互组件没有实现时拒绝，而不是只保留文本
- 被动回复 msg_id/event_id 与引用展示 message_reference 是不同语义。msg_seq 使用调用方给出的序号，缺省 1；重放同一动作不能随机换序号绕过平台去重
- message.delete 分别映射私聊、群聊和频道的 DELETE 路径；成功响应允许无正文。单聊只撤回自己消息，私聊/群聊存在 120 秒时限；群和频道还有角色或资格限制
- 入站使用官方 OpenID，群成员支持 author.member_openid；群全量消息依赖平台资格。Webhook 的本地 ready 不代表平台鉴权与投递已验证，未实现的 WebSocket 网关不能报告在线

文件上传、富媒体发送、表情回应、交互键盘等虽有官方接口，但当前 QQ adapter 未实现的部分仍明确 unsupported。这些原生能力不会因此被删掉；后续实现应增加映射和回归检查，而不是重新定义另一套原生协议。

## 后续需确定的接入语义

1. 原生服务的持久化与鉴权：协议和分发通路已经完整，实际原生聊天后端、资源存储、角色权限和 WebUI 传输接口仍需业务实现，不由平台 adapter 模拟
2. 多次回复的序号分配：同一外部消息的多个原生回复需要 Runtime 分配并持久化 sequence；当前 adapter 的缺省 1 只适用于单次回复，不能代替持久化分配器
3. 平台文档差异：官方单聊概述写 60 分钟，被动 msg_id 参数描述仍写 5 分钟。当前事件提示保留 60 分钟，平台拒绝照常回传；不能把该提示当作保证
4. 能力依赖权限与上下文：群全量事件、主动消息、管理员撤回、频道资格及富媒体额度不能仅由静态能力档案保证；后续需要账号授权状态和动态能力刷新
5. 流式与复合管理：原生定义 streamId/sequence/state 以及成员变更等动作，具体服务仍需约定顺序、取消、断线补偿、分页与组合操作的原子性；未实现的 adapter 保持明确拒绝

当前 Runtime CLI/TUI 是管理客户端，不当作聊天 channel 注册。未来若增加终端或 WebUI 对话入口，应使用此原生协议，并保留管理命令和消息输入的边界。
