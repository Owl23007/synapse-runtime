# Channel 架构整理

已完成 PR1（协议契约与统一动作模型）和 PR2（OneBot11 职责拆分）。采用单一契约，不保留旧类型别名、布尔能力回退或双轨结果模型。公共 API 调用方随契约同步修改；群聊工件交付、DAG、权限、幂等和恢复的业务要求继续保留。

## 实际职责与依赖

- `protocol/src/types.ts` 原先已有动作、能力档案和动作结果，`channel/src/types.ts` 又定义了布尔能力、重复目标和消息/上传回执
- Runtime 消息发送已经调用 `executeChannelAction()`；应用的工件交付组合层直接调用 `uploadGroupFile()`，并在 `ArtifactDeliveryStore` 管理归属、幂等与未决占位
- OneBot11 的 `adapter.ts` 组合传输、标准 API 与可选 NapCat API；协议编解码与消息/事件归一化独立于传输
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

## PR2 文件与职责

| 文件                                                          | 职责                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `channel-onebot11/src/adapter.ts`                             | 选择传输、组合标准与扩展 API、管理规范事件处理器                           |
| `transport.ts`、`http-transport.ts`、`websocket-transport.ts` | 请求传输契约、HTTP 取消/超时、WebSocket 建连与 echo 关联                   |
| `codec.ts`、既有 `message.ts` 和 `normalize.ts`               | 请求/回执编解码、消息片段编码和事件归一化，不依赖具体传输或 API            |
| `api.ts`                                                      | 标准消息 API，只执行标准动作，拒绝文件扩展和不支持的消息片段               |
| `napcat.ts`                                                   | NapCat 文件上传及附件交付编排，群文件约束与实现来源统一声明                |
| `types.ts`                                                    | 保留已实现的 HTTP/WebSocket 模式及可注入宿主依赖，移除未实现的混合传输模式 |
| `api.test.ts`、`transport.test.ts`                            | 标准/扩展隔离、部分交付、乱序回执、取消、断线、重连及定时器清理            |
| `tools/check-boundaries.mjs`                                  | 限制 OneBot11 内部反向依赖，`ws` 只由 WebSocket 传输导入                   |

没有新增包。公开配置仍只启用已部署实现的 WebSocket；HTTP 可通过 Adapter 注入测试或宿主显式使用，入站事件由宿主交付。关闭前未完成的建连会被拒绝，HTTP 断开会取消请求与响应体等待；任何传输中断都不能被解释为平台没有执行。旧 socket 的回调不能改变新连接状态，全部请求都有独立 echo，且在终态释放定时器。

## 后续 PR

PR3 将应用组合层的群文件调用迁移至统一动作入口，保留权限检查、工件归属、交付去重、持久化与恢复所在层。运行目标由真实事件和会话决定，不开放给模型任意指定。随后再以 Runtime 的对话/任务用例定义 WebUI/CLI 可直接消费的 Runtime API。

## 风险与验证

- 能力声明必须与 Adapter 实现一致，执行器在方法缺失时仍返回 `unsupported`；部分支持必须校验目标与大小，额外平台约束由 Adapter 校验
- 传输异常、超时、异步受理及已完成部分附件交付均不能当作明确失败；消息和上传的 `uncertain` 不自动重试
- 上传动作携带内存字节，不能直接 JSON 序列化用于恢复；工件 ID、字节校验和恢复策略继续属于 Runtime
- PR1 必须调整公共类型的现有测试替身和回执断言，同时保留原有行为断言，不用修改断言规避实现错误
- 执行仓库完整 `pnpm verify`，覆盖架构、fixtures、构建、类型、配置、国际化、单元与进程集成测试
