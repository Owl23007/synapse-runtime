# Channel 架构整理

本轮完成 PR1：协议契约与统一动作模型。采用单一契约，不保留旧类型别名、布尔能力回退或双轨结果模型。公共 API 调用方随契约同步修改；群聊工件交付、DAG、权限、幂等和恢复的业务要求继续保留。

## 实际职责与依赖

- `protocol/src/types.ts` 原先已有动作、能力档案和动作结果，`channel/src/types.ts` 又定义了布尔能力、重复目标和消息/上传回执
- Runtime 消息发送已经调用 `executeChannelAction()`；应用的工件交付组合层直接调用 `uploadGroupFile()`，并在 `ArtifactDeliveryStore` 管理归属、幂等与未决占位
- OneBot11 的 `adapter.ts` 同时处理 HTTP、WebSocket、请求关联/超时、消息编码、文件上传和生命周期；`message.ts` 与 `normalize.ts` 已提供部分编解码边界
- Runtime 的 `send_failed` 可以恢复重试；发送结果不确定必须留在 `send_uncertain` 路径，不能触发自动重发

## 目标结构

```text
WebUI / CLI ── Runtime API（对话、任务执行）
            └ Admin API（配置、状态、运维）
                       ↓ 应用组合
Runtime（权限、会话、DAG、幂等、持久化、恢复）
                       ↓
channel（统一动作执行、Adapter 生命周期、注册表）
                       ↓
具体 Adapter（外部平台 API、传输、编解码）

protocol ← 上述模块共同使用的目标、动作、能力和回执契约
```

API 边界描述的是职责，不代表 PR1 已新增 Runtime HTTP 路由。当前 `runtime-client` 仍主要提供 Admin API，后续应单独设计对话与任务执行入口，不能让 WebUI/CLI 直接操作平台 Adapter。

能力档案只描述平台实现的支持程度和约束，不代表用户被授权执行。入站事件上的 `AdapterCapabilities` 描述本次事件的路由/回复上下文，与动作授权分开。

`ChannelOperationResult` 是平台操作的唯一回执模型；`ChannelActionResult` 在它之上增加动作标识、执行时间等观测字段。消息和上传使用相同状态，`succeeded` 携带 `messageId` 或 `fileId`，其他终态携带 `error`。

标准动作包括消息发送/编辑/删除、Reaction 和群文件上传；执行器当前实现发送和群文件上传，其余明确返回 `unsupported`。`platform.execute` 根据完整的 `namespace:operation` 能力声明分派扩展动作，不能凭通用的 `platform.execute` 声明执行任意扩展。

标准动作可以由平台扩展实现，例如 `file.upload` 的 `implementation: "napcat:upload_group_file"`。这表示 Adapter 实现了统一群文件语义，不表示 OneBot11 标准原生定义了上传 API。PR1 没有为 NapCat 新增任意 API 调用入口。

## PR1 文件清单

| 文件                                                                                                   | 修改                                                                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/protocol/src/types.ts`、`index.ts`                                                           | 唯一的目标、能力、动作与回执契约，约束及平台扩展标识                       |
| `packages/protocol/src/actions.ts`、`message.ts`                                                       | 动作工厂独立于消息内容辅助函数，增加群文件上传工厂                         |
| `packages/channel/src/types.ts`、`index.ts`                                                            | 只保留生命周期与注册表抽象，直接引用协议契约                               |
| `packages/channel/src/action-executor.ts`                                                              | 检查频道归属、能力、目标和上传大小，分派消息/上传/显式扩展，统一终态       |
| `packages/channel/src/action-executor.test.ts`、测试配置                                               | 覆盖约束、能力与实现不一致、跨频道拒绝、命名空间隔离和未知回执             |
| 两个 Adapter 的 `adapter.ts`、消息辅助函数和相关测试                                                   | 同步采用唯一契约，声明平台支持范围，返回统一状态                           |
| `packages/runtime-core/src/runtime/runtime-core.ts`、消息辅助函数与相关测试                            | 必要的类型/字段消费适配，显式保留未知结果的恢复语义                        |
| `apps/runtime/src/composition/artifact-delivery.ts`、`container-tools.ts`、`server/runtime-factory.ts` | 消费统一回执和能力，保留原有工件交付仓储及授权流程                         |
| `tools/check-boundaries.mjs`                                                                           | 禁止 protocol 依赖实现、channel 依赖具体模块、RuntimeCore 依赖具体 Adapter |

## 后续 PR

PR2 在现有 OneBot11 包内分离传输、编解码、标准 API、NapCat 扩展与生命周期，不新增无必要的包。HTTP/WebSocket 拥有请求发送与超时/断线；协议层拥有请求/响应/事件编解码；标准 API 只包含标准操作；NapCat 文件 API 独立声明支持与约束；Adapter 只组合这些对象并管理连接/事件订阅。保留注入传输的测试方式，重点验证 echo 关联、断线与部分上传的不确定性。

PR3 将应用组合层的群文件调用迁移至统一动作入口，保留权限检查、工件归属、交付去重、持久化与恢复所在层。运行目标由真实事件和会话决定，不开放给模型任意指定。随后再以 Runtime 的对话/任务用例定义 WebUI/CLI 可直接消费的 Runtime API。

## 风险与验证

- 能力声明必须与 Adapter 实现一致，执行器在方法缺失时仍返回 `unsupported`；部分支持必须校验目标与大小，额外平台约束由 Adapter 校验
- 传输异常、超时、异步受理及已完成部分附件交付均不能当作明确失败；消息和上传的 `uncertain` 不自动重试
- 上传动作携带内存字节，不能直接 JSON 序列化用于恢复；工件 ID、字节校验和恢复策略继续属于 Runtime
- PR1 必须调整公共类型的现有测试替身和回执断言，同时保留原有行为断言，不用修改断言规避实现错误
- 执行仓库完整 `pnpm verify`，覆盖架构、fixtures、构建、类型、配置、国际化、单元与进程集成测试
