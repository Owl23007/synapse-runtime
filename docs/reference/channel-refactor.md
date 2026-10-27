# Channel 架构整理

PR1（协议契约与统一动作模型）、PR2（OneBot11 职责拆分）和 PR3（Runtime 调用入口收敛）均已完成。采用单一契约，不保留旧类型别名、布尔能力回退或双轨结果模型。公共 API 调用方随契约同步修改；群聊工件交付、DAG、权限、幂等和恢复的业务要求继续保留。

## 实际职责与依赖

- `protocol/src/types.ts` 原先已有动作、能力档案和动作结果，`channel/src/types.ts` 又定义了布尔能力、重复目标和消息/上传回执
- Runtime 的消息和群文件上传都调用 `executeChannelAction()`；应用的 `ArtifactDeliveryStore` 继续管理工件回执、幂等与未决占位，Channel 不持久化恢复策略
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

API 边界描述的是职责，本轮没有新增 Runtime HTTP 路由。当前 `runtime-client` 仍主要提供 Admin API，包括只读运行检查与 SSE；后续应单独设计对话与任务执行入口，不能让 WebUI/CLI 直接操作平台 Adapter。

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

## PR3 文件与职责

| 文件                                                           | 修改                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/composition/channel-delivery.ts`             | 工具上传与自动交付共用的 Runtime 用例；构造 `file.upload` 动作，再经统一执行器执行        |
| `container-tools.ts`、`docker-artifacts.ts`                    | 移除直接上传调用；目标继续取自真实工具/会话上下文，上传前仍校验工件归属与最终选择         |
| `server/runtime-factory.ts`                                    | 依赖 `ChannelRegistry` 抽象；工具可见性按群文件能力及目标约束判断                         |
| `runtime-core/src/runtime/message-utils.ts`、`runtime-core.ts` | 权限键取自规范事件平台，区分 Runtime 权限键与 Channel 动作标识，QQ 现有策略键保持一致     |
| `channel-delivery.test.ts`、`runtime-core.test.ts`             | 并发与重启去重、跨群/频道隔离、失败和未知回执保留、缺失实现与大小约束拒绝、多平台权限消费 |
| `tools/check-boundaries.mjs`                                   | 禁止 RuntimeCore 与 Runtime 宿主直接调用平台发送、上传和扩展方法，强制走统一动作入口      |

工具与自动交付使用相同的会话、频道、群、工件身份构造动作 ID 和幂等键；`ArtifactDeliveryStore` 在动作执行前占位，在获得结果后落盘回执。Channel 只执行能力检查与平台分派，不替 Runtime 去重、重试或恢复。持久工件回执只保存平台状态与文件 ID，不保存动作元数据或文件字节。结果未知时保留人工核对边界，重启与新工具调用都不会重复上传。

不支持、能力声明与实现不一致或目标/大小约束不满足时，自动交付返回明确失败，不能将同一附件绕过执行器转入普通消息发送。

## 后续范围

本轮三个 PR 完成后，可独立设计 WebUI/CLI 的对话与任务执行 Runtime API：在既有 Runtime 用例上提供请求与事件接口，并单独定义客户端会话身份、任务权限与取消语义。Admin 继续承担配置、状态和运维管理，Channel API 继续只面向外部平台。

## 风险与验证

- 能力声明必须与 Adapter 实现一致，执行器在方法缺失时仍返回 `unsupported`；部分支持必须校验目标与大小，额外平台约束由 Adapter 校验
- 传输异常、超时、异步受理及已完成部分附件交付均不能当作明确失败；消息和上传的 `uncertain` 不自动重试
- 上传动作携带内存字节，不能直接 JSON 序列化用于恢复；工件 ID、字节校验和恢复策略继续属于 Runtime
- PR1 必须调整公共类型的现有测试替身和回执断言，同时保留原有行为断言，不用修改断言规避实现错误
- 执行仓库完整 `pnpm verify`，覆盖架构、fixtures、构建、类型、配置、国际化、单元与进程集成测试
