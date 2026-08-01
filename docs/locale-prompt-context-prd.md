# Synapse Runtime Locale、Prompt Registry、上下文合成与前缀缓存重构 PRD

- **版本：** v0.3
- **状态：** 已完成实现方式评审，待排期
- **优先级：** P0
- **首期语言：** `zh-CN`
- **适用范围：** Runtime 错误、模型输入、上下文合成、人格表达、配置与可观测性

## 1. 结论

本次重构采用以下实现方向：

1. Error 使用稳定错误码和结构化参数，中文只在展示边界解析，不以中文文本参与业务判断。
2. Prompt 迁移到统一 Registry；业务代码不得继续新增长 Prompt，但短小、确定性的协议常量不强制模板化。
3. 复用现有 `PromptContext`、`ContextComposer` 和 `BranchContextProjector` 演进，不平行创建第二套上下文系统。
4. 上下文先生成结构化区块，再按稳定性、权限和预算渲染成 Provider 消息。
5. 模型输入保持“稳定前缀在前、动态后缀在后”，但不在 Runtime 中模拟 Provider 的 KV Cache。
6. 用户可编辑人格不得进入 Reasoning；需要模型改写的人格表达是可选的第二阶段，不作为每轮默认调用。
7. 主运行配置继续使用现有 TOML/YAML/JSON Loader；Prompt、Locale 和上下文策略使用独立资源文件，P0 不拆分 providers/channels 配置。

## 2. 背景与现状

当前实现已经具备上下文闭环的基础，但内容管理和错误展示仍存在明显耦合。

### 2.1 当前实现

- `packages/runtime-core/src/context/composer.ts` 负责历史、时间、输出策略和会话状态合成。
- `packages/runtime-core/src/context/projection.ts` 已能投影 Branch、Task、结果和相关证据，并记录来源清单及字符预算。
- `packages/conversation/src/types.ts` 中的 `PromptContext` 目前只有单个 `system`、历史 `messages` 和字符串 metadata。
- `packages/agent-api-provider/src/provider.ts` 按“全局 systemPrompt、Context system、历史、当前输入”的顺序创建模型消息。
- `packages/config/src/schema.ts` 将 `agent.systemPrompt` 作为一段自由文本配置。
- 配置错误已有 `ConfigError.code`，会话和工具恢复也有局部错误码，但多数模块仍直接抛出 `Error`。
- Admin API 已使用 `error` 字段返回机器码，Runtime 的 Task、Event 和 Trace 中也存在错误文本或对象。

### 2.2 当前问题

- Runtime 规则、当前时间、输出策略和会话状态被拼成一段动态 system 文本，无法独立治理和预算。
- `agent.systemPrompt` 与 Context system 是两个隐式层级，覆盖关系、版本和变量均不可检查。
- 时间、会话状态等高频变化内容出现在 system 区域，降低公共前缀复用长度。
- Prompt 文本散落在 Composer、Provider、工具和业务模块中，缺少 ID、版本与回放依据。
- 错误码、英文异常、中文提示和 API 机器码没有统一边界。
- 自由文本人格若直接进入 system Prompt，会影响任务拆解、工具选择与事实判断。

## 3. 目标

### 3.1 产品目标

- 用户可见的首批 Runtime 错误提供统一中文信息。
- Prompt 可集中查看、校验、版本化和按场景选择。
- Context Composer 能表达来源、可信度、稳定性、预算和裁剪结果。
- 相同模型、规则、工具集合和 Workspace 的请求尽可能复用相同前缀。
- 人格只改变表达，不得覆盖权限、安全、事实、工具结果和任务状态。
- 每次调用可追溯所用 Prompt、策略、区块清单和缓存统计。

### 3.2 非目标

P0 不包含：

- `en-US`、`ja-JP` 等完整翻译；
- Prompt 在线编辑后台、A/B Test 或自动优化；
- 自建 KV Block、跨 Provider KV 迁移或 Runtime 侧推理缓存；
- 所有内部异常一次性改造；
- 默认对每条聊天回复执行第二次人格模型调用；
- 长期记忆和多 Agent 编排重构；
- 将现有主配置拆成多个可 include 的 TOML 文件。

## 4. 核心原则

### 4.1 机器标识与展示文本分离

错误码、Locale Key、Prompt ID、字段名和 API `error` 保持英文稳定值；中文仅作为可替换的展示资源。

业务逻辑不得匹配中文或英文错误句子。现有通过 `message.includes(...)` 判断错误类型的路径应迁移为错误码判断。

### 4.2 Domain 产生错误，边界负责本地化

Domain、Provider 和 Adapter 负责产生稳定 code、参数和内部 details，不负责选择语言。Runtime Server、CLI、Channel 回复等展示边界根据 Locale 生成用户消息。

日志保留原始 cause 和结构化 details；默认不把底层 Provider 响应、密钥、请求体或堆栈发送给用户。

### 4.3 上下文先结构化，再渲染

Context Composer 先产出有类型的区块集合，随后由 Prompt Renderer 生成 Provider 消息。区块应能独立排序、裁剪、摘要和记录来源。

### 4.4 稳定性不能高于权限正确性

不得为了缓存命中复用过期的工具白名单、权限、Workspace 内容或输出协议。权限或工具集合改变时，即使降低命中率，也必须生成新前缀。

### 4.5 人格与行为规则分离

- Behavior Policy 是不可由用户覆盖的行为约束，可以参与 Reasoning。
- Presentation Profile 是语气、长度、称呼、Markdown 和分段偏好，不得参与工具选择和事实判断。
- 单次模型调用无法严格保证“人格不影响推理”。需要强隔离时必须采用 Canonical Result 加独立 Presentation 阶段。

## 5. 目标架构

模型调用主链路调整为：

```text
Channel Event → Context Strategy Router → Context Composer
→ Prompt Registry / Renderer → Prompt Envelope
→ Agent / Provider → Canonical Result
→ Presentation Policy → Channel Renderer → Output
```

错误链路调整为：

```text
原始异常 → Domain Error / Error Mapper → Error Descriptor
→ Locale Resolver → CLI、API 或 Channel 展示
```

### 5.1 模块职责

| 模块                     | 目标职责                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| `runtime-conversation`   | 演进 Prompt Context 契约，保留兼容入口                           |
| 新增 `runtime-resources` | Prompt/Locale 定义、加载、校验、模板编译和查询接口               |
| `runtime-core`           | 场景路由、区块收集、排序、预算、裁剪、Trace 和错误归一化         |
| `agent-api-provider`     | 确定性序列化 Prompt Envelope，适配 Provider 缓存能力并解析 usage |
| `runtime-config`         | 声明默认 Locale、资源路径、策略与功能开关，不承载资源正文        |
| `runtime-server`         | 加载资源、依赖注入、启动校验和 CLI/API 展示本地化                |

Domain 包不应为了翻译而直接依赖完整 Catalog。它们只需抛出自身稳定的错误码，或由 Runtime 边界映射未知异常。

## 6. Error Locale

### 6.1 错误描述契约

可本地化错误至少包含：

| 字段        | 说明                                                    |
| ----------- | ------------------------------------------------------- |
| `code`      | 稳定机器码，用于控制流、API 和指标                      |
| `key`       | Locale 查询键；通常可由 code 映射，不要求每次抛错都填写 |
| `params`    | 可序列化插值参数，不包含秘密                            |
| `retryable` | 是否适合重试                                            |
| `severity`  | `info`、`warning`、`error` 或 `fatal`                   |
| `expose`    | 是否允许向普通用户展示具体信息                          |
| `details`   | 仅供日志、Trace 和运维使用的结构化详情                  |
| `cause`     | 内存中的原始异常，不进入 API 或持久化记录               |

Task 和 Event 需要持久化错误时，只保存可序列化描述，不保存 `Error` 实例或堆栈。

### 6.2 Locale 解析顺序

接口预留以下优先级：

1. 本次调用显式 Locale；
2. 用户偏好；
3. Workspace 偏好；
4. Channel 偏好；
5. Runtime 默认 Locale；
6. `zh-CN`。

P0 只要求 Runtime 默认值和 `zh-CN` Catalog 生效。未知 Locale 回退到 `zh-CN`，缺失 Key 回退到安全的通用错误，并记录 `locale_missing_key` 指标。

### 6.3 展示边界

- Admin API 保留现有 `error` 机器码，可新增 `message` 作为中文展示，不改变调用方判断字段。
- CLI/TUI 显示中文 message；debug 模式可附 error code。
- Channel 只发送允许暴露的中文信息；不可暴露错误统一显示通用提示。
- 日志以 code、params、details、cause 为主，不依赖本地化文案检索。

### 6.4 P0 错误范围

首批至少覆盖：

- 配置文件读取、解析、环境变量缺失和校验失败；
- Agent Provider 未配置、鉴权失败、限流、超时、响应无效；
- Prompt 不存在、版本冲突、变量缺失和模板渲染失败；
- Context 合成失败、预算不足和输入超限；
- 工具禁用、权限拒绝、执行失败、调用数超限；
- Channel 未注册、未连接、发送失败和投递结果不确定；
- Task 不存在、执行器不可用、取消和执行失败；
- Runtime 内部错误。

存储层不变量、迁移和开发参数校验等仅进入日志的异常可后续迁移，不阻塞 P0。

## 7. Prompt Registry

### 7.1 Prompt 分类

| 阶段           | 用途                               | 示例                              |
| -------------- | ---------------------------------- | --------------------------------- |
| `reasoning`    | 任务理解、规划、工具选择、结果生成 | 普通聊天、Task 执行、工具结果分析 |
| `internal`     | 摘要、检索查询、记忆提取、意图分类 | Branch 摘要、历史压缩             |
| `presentation` | 可选的人格化模型改写               | 私聊、群聊、Task 结果             |

错误提示、命令响应、状态通知等确定性文本归 Locale Catalog 管理，不为它们执行模型 Prompt。

### 7.2 Prompt 定义

每条 Prompt 至少声明：

- 唯一 ID、语义版本、Locale、阶段和场景；
- 描述、模板正文、必需变量和可选变量；
- 是否启用、允许的覆盖层级和安全等级；
- 所属 cache group、是否允许进入稳定前缀；
- 输出契约版本；
- 变更说明。

模板只允许白名单变量，启动时检查引用完整性。未知变量、重复 ID、无效版本和场景引用均视为启动错误。

### 7.3 覆盖规则

覆盖层级为 Runtime、Workspace、User：

- Runtime 安全、权限、工具规则和输出协议不可覆盖；
- Workspace 只能追加注册过的领域上下文，或选择允许覆盖的 Prompt；
- User 只能选择 Presentation Profile，不得替换 Reasoning 或 Internal Prompt；
- 覆盖后的有效 Prompt 必须产生独立版本摘要，供 Trace 与缓存失效使用。

P0 可只实现 Runtime Catalog，但数据模型必须保留覆盖策略字段，避免以后修改格式。

## 8. 上下文合成

### 8.1 在现有实现上演进

现有 `ContextComposer` 继续作为入口，`BranchContextProjector` 继续负责 Branch 语义投影。重构重点是把当前 `buildContextSystemPrompt` 中的混合字符串拆成 Context Block，而不是重写数据获取逻辑。

现有 `PromptContext.system` 在一个兼容周期内保留。新路径生成 Prompt Envelope；旧 Agent 或测试仍可由兼容 Renderer 合成为单个 system 字符串。

### 8.2 Context Block 元数据

每个区块需要表达：

- ID、类型、来源和内容版本；
- 可信等级与权限域；
- 优先级、必需性和裁剪策略；
- 稳定级别：全局、Workspace、会话或单轮；
- 预算估算与实际长度；
- 是否包含敏感内容；
- 可进入的缓存范围。

### 8.3 推荐顺序

| 顺序 | 区域           | 典型内容                                                      |
| ---- | -------------- | ------------------------------------------------------------- |
| 1    | 全局稳定前缀   | Runtime 核心规则、Behavior Policy、Reasoning Prompt、输出契约 |
| 2    | 能力稳定前缀   | 按稳定 ID 排序的 Tool Schema、权限解释规则                    |
| 3    | Workspace 前缀 | 稳定项目说明、术语和长期规则                                  |
| 4    | 会话半稳定区   | Task 定义、Branch Summary、已确认约束                         |
| 5    | 动态上下文     | 检索结果、工具结果、最近历史、会话投影                        |
| 6    | 单轮输入       | 当前时间、事件信息和当前用户消息                              |

当前时间不得进入稳定 system 前缀。历史消息继续保持消息角色，不应整体序列化进 system 文本。

### 8.4 预算与裁剪

P0 从现有字符预算平滑迁移，接口同时记录估算 Token；Provider 支持精确 tokenizer 时再切换为 Token 预算。

裁剪顺序为：

1. 去重和删除过期历史；
2. 删除低相关检索证据；
3. 缩短可裁剪的工具结果；
4. 使用已有 Branch Summary 或投影摘要；
5. 缩短普通历史；
6. 返回结构化预算错误。

Runtime 核心规则、实际权限、当前输入和输出契约不得整体裁剪。每次裁剪必须写入 Context Trace。

## 9. 人格与 Presentation

### 9.1 P0 默认行为

- Reasoning 不注入用户可编辑的自由文本人格。
- 普通聊天默认直接使用 Reasoning 结果，仅执行确定性的长度、Markdown、分段和 Channel 能力处理。
- 错误、命令和状态消息由 Locale 模板直接渲染。
- Internal Prompt 永不注入 Presentation Profile。

### 9.2 可选模型 Presentation

确实需要显著人格化时，可启用独立 Presentation 调用。其输入是 Canonical Result、Presentation Profile、Locale 和 Channel 能力，不包含工具权限或完整历史。

Presentation 不得改变事实、数字、时间、代码语义、引用、权限结论、成功状态和风险提示。失败时直接回退到 Canonical Result 的安全文本版本。

该模式必须单独记录延迟、Token 和回退率，并允许按场景关闭。P0 不以其为默认验收条件。

## 10. 前缀 KV Cache

### 10.1 范围

Runtime 负责产生确定、可复用的输入前缀和观测缓存 usage。真实 KV Cache 由 Provider 管理；不支持缓存的 Provider 必须无行为差异地降级。

### 10.2 确定性要求

- 区块和工具按稳定 ID 排序；
- 模板渲染、字段顺序、换行、空块处理保持一致；
- 前缀不包含时间、随机 ID、调用 ID、动态历史或检索结果；
- Prompt、Behavior Policy、输出契约和 Tool Schema 变化必须改变摘要；
- 含 Workspace 私有内容的前缀不得跨 Workspace 或权限域复用；
- Provider 请求参数中影响输入语义的部分纳入 Trace 摘要。

### 10.3 摘要维度

用于本地编译缓存、Trace 和失效判断的摘要至少包含：Provider、Model、Prompt ID/版本、Locale、Context Strategy、Behavior Policy 版本、输出契约版本、Tool Set Digest、权限域、Workspace 稳定上下文摘要和 Provider 适配版本。

该摘要不冒充 Provider 的服务端 cache key。只有 Provider 明确支持显式 cache key 时，Adapter 才能传递对应参数。

### 10.4 Provider 适配

Provider Adapter 声明缓存能力：是否自动前缀缓存、是否支持显式 key/retention，以及 usage 中缓存 Token 的字段映射。未知能力按不支持处理，不向 `extraBody` 猜测注入厂商参数。

## 11. 配置设计

### 11.1 文件布局

P0 推荐保留一个主运行配置，并新增资源目录：

```text
config/
├── runtime.toml
└── resources/
    ├── prompts.zh-CN.yaml
    ├── locales.zh-CN.yaml
    ├── context-strategies.yaml
    └── presentation-profiles.yaml
```

主配置只新增默认 Locale、资源路径、默认 Context Strategy、缓存开关和 Presentation 模式。Provider、Channel、Permission 等现有配置继续留在主文件。

### 11.2 兼容策略

- 旧 `agent.systemPrompt` 在一个兼容周期内可独立使用，并标记 deprecated。
- 新 Prompt Registry 与 `agent.systemPrompt` 不允许同时启用，启动校验直接报错，避免隐式覆盖。
- 未配置 Registry 时保持现有行为，便于渐进升级和回滚。
- 资源路径沿用现有 Loader 的相对路径和 `~` 规范化规则。
- P0 不引入配置 include；资源文件由专用 Loader 加载，避免扩大主配置重构范围。

## 12. 启动校验

启动阶段必须检查：

- 默认 Locale 及 Catalog 是否存在；
- Locale Key、Prompt ID 和版本是否重复；
- Prompt 变量声明与模板引用是否一致；
- Context Strategy 引用的 Prompt、区块、工具集合和 Profile 是否存在；
- 稳定前缀是否意外引用单轮变量；
- Presentation Profile 是否包含禁止的行为、权限或工具字段；
- 新旧 system Prompt 配置是否冲突；
- Provider cache 配置是否与能力声明匹配。

开发模式可输出全部问题；生产启动只要存在 error 级问题即失败。

## 13. 可观测性

每次模型调用至少记录：

- Invocation、Session、Line、Branch 和 Workspace ID；
- 场景、Prompt ID/版本、Locale、Context Strategy；
- Context Block 清单、来源摘要、预算和裁剪原因；
- Provider、Model、Tool Set Digest 和权限域；
- 稳定前缀长度、动态后缀长度、输入/输出 Token；
- 本地编译缓存命中、Provider 缓存状态和缓存 Token；
- Presentation 是否执行、耗时和是否回退；
- Error code、retryable 和 severity。

日志默认只保存摘要、长度和哈希，不保存完整 Prompt、历史、私有 Workspace 文本或工具结果。

## 14. 实施计划

### PR-1：Error 契约与中文 Catalog

交付：

- 新增资源包及 Locale Loader/Resolver；
- 定义可序列化 Error Descriptor 和边界 Error Mapper；
- 接入 Config、Agent、Context、Tool、Channel 和 Task 首批错误；
- Admin API 保留 `error` 并增加 `message`；
- CLI/TUI 和 Channel 使用 `zh-CN`；
- 移除用户路径中依赖错误 message 判断的逻辑。

### PR-2：Prompt Registry 与配置迁移

交付：

- Prompt 定义、Loader、Registry、Renderer 和启动校验；
- 首批中文 Reasoning/Internal Prompt；
- 新增资源路径配置；
- `agent.systemPrompt` 兼容与弃用告警；
- Prompt ID、版本和变量测试。

### PR-3：结构化 Context 与稳定前缀

交付：

- Context Block、Strategy Router、预算和 Trace；
- 复用现有 Composer/Projector 的数据收集；
- Prompt Envelope 与旧 `PromptContext.system` 兼容 Renderer；
- 稳定顺序、工具摘要和 Workspace 隔离；
- Provider cache capability 与 usage 映射。

### PR-4：Presentation 隔离

交付：

- Presentation Profile 和确定性 Channel Renderer；
- Canonical Result 契约与安全回退；
- 可选模型 Presentation 开关与指标；
- 删除 Reasoning 中的用户自由文本人格入口。

## 15. 验收标准

### 15.1 Error Locale

- P0 错误均有稳定 code 和中文展示。
- Admin API 现有 `error` 值保持兼容。
- 用户不可见底层 Provider 响应、堆栈和敏感 details。
- 缺失 Key 有安全回退和指标。
- 业务代码不通过中文或英文错误句子分支。

### 15.2 Prompt 与 Context

- 生产 Prompt 可由 Registry 完整枚举并通过启动校验。
- 相同输入条件生成字节稳定的公共前缀。
- 时间、历史、检索和调用 ID 不进入稳定前缀。
- Tool 或权限变化会生成不同摘要。
- 现有 Branch 投影、历史 TTL 和幂等恢复测试保持通过。
- 预算裁剪可回放且不会删除核心规则、权限和当前输入。

### 15.3 Presentation

- 用户人格不进入 Reasoning 和 Internal Prompt。
- 错误、命令和状态消息不依赖第二次模型调用。
- 模型 Presentation 失败时仍能返回事实一致的结果。
- 未启用新资源配置时，旧配置可继续运行。

## 16. 风险与对策

| 风险                                      | 对策                                                |
| ----------------------------------------- | --------------------------------------------------- |
| 一次性替换全部 Error 导致范围失控         | P0 只改用户边界和核心执行路径，内部不变量分阶段迁移 |
| 新旧 Prompt 双源导致行为不确定            | 禁止同时启用，启动时失败                            |
| 两阶段人格增加成本和延迟                  | 默认确定性渲染，模型 Presentation 按场景开启        |
| 为缓存优化错误复用权限或私有上下文        | 摘要包含权限域和 Workspace，正确性优先              |
| 字符预算与真实 Token 偏差                 | P0 双记字符和估算 Token，逐 Provider 接入 tokenizer |
| Prompt 外置后被任意覆盖                   | 严格 schema、覆盖白名单、版本摘要和启动校验         |
| 大规模修改 `PromptContext` 破坏现有 Agent | 保留兼容字段与 Renderer，一个兼容周期后再移除       |

## 17. 发布与回滚

- 新能力使用功能开关，可按 Error Locale、Prompt Registry、Structured Context 和 Model Presentation 分别启用。
- 每个阶段均需保留旧路径的对照测试，禁止在同一版本同时删除旧配置和启用强制迁移。
- 回滚时停用新 Registry 即恢复 `agent.systemPrompt` 路径；数据层只新增结构化字段，不覆盖已有 Task/Event 原始记录。
- 完成一个兼容周期且迁移率达到 100% 后，另立变更移除 `agent.systemPrompt` 和单一 system 兼容接口。
