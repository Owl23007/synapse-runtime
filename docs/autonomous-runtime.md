# 有限自主执行

自主执行的授权来自宿主接受的输入，不来自模型参数。模型可以创建目标、安排未来工作、选择上下文、决定静默或通知；它不能修改部署配置、提升授权或扩大通知目标

自主执行与普通对话共用 `runtime.config.toml`。完整部署示例 `examples/runtime.config.toml` 包含执行容量、自主额度、上下文和模型循环配置，沿用同一份模型提供者、权限及 Prompt Bundle；无需额外加载自主配置文件

## 上限

下表是未配置时的内置默认值。完整部署示例显式采用更保守的值：每小时 30 次 Run、每份授权累计 12 次 Run、最多 2 次尝试、16 个目标、8 个计划、72 小时授权寿命和每作用域 500 个上下文版本

| 配置                                 | 默认值    | 约束                                             |
| ------------------------------------ | --------- | ------------------------------------------------ |
| `autonomy.maxRunsPerGrant`           | 24        | 一份授权包含交互与后续工作的累计 Run 数          |
| `autonomy.maxRunsPerHour`            | 60        | 同工作区一小时内接受的 Run 数                    |
| `autonomy.maxAttempts`               | 3         | 同一 Run 的恢复尝试次数                          |
| `autonomy.maxModelCallsPerRun`       | 8         | 跨 Attempt 累计的模型调用次数                    |
| `autonomy.maxToolCallsPerRun`        | 16        | 跨 Attempt 累计的工具调用次数                    |
| `autonomy.maxPendingIntents`         | 128       | 全实例持久待办与已领取工作总数                   |
| `autonomy.maxTasks` / `maxTaskDepth` | 32 / 3    | 工作区目标总量与父子深度                         |
| `autonomy.maxSchedules`              | 16        | 工作区计划总量                                   |
| `autonomy.maxScheduleOccurrences`    | 24        | 每个计划的触发次数上限，跳过也计次               |
| `autonomy.maxScheduleLifetimeHours`  | 168       | 授权与计划的最长寿命                             |
| `autonomy.minScheduleIntervalMs`     | 300000    | 周期计划的最短 UTC 间隔                          |
| `autonomy.maxContextCommits`         | 1000      | 每个授权上下文作用域的版本总量                   |
| `autonomy.maxRecordChars`            | 32000     | 单条执行内容与结果的上限                         |
| `autonomy.maxDatabaseBytes`          | 536870912 | SQLite 主库增长上限，另预留收尾空间              |
| `autonomy.observationTtlMinutes`     | 30        | 未触发消息的短期观察期限                         |
| `autonomy.maxObservationsPerSession` | 64        | 单会话观察数量                                   |
| `context.maxTotalChars`              | 24000     | 当前输入、提示词、上下文及工具定义共用的请求预算 |

这些限制同时生效。模型创建后续 Task Run 或 Schedule 不会刷新原授权寿命和累计额度，进程重启不会重置调用计数。已有 `runtime.limits` 继续限制并发、队列、Run 截止、工具截止和退出收尾

达到存储或对象总量上限会拒绝新增工作，不会自动删除权威任务、资源、未决外部动作或既有历史。`autonomy.enabled = false` 禁止后续自主工作，普通显式交互仍可执行

## 执行与恢复

输入观察、上下文候选资格和是否唤醒分别判断。未触发消息不创建 Run；发送回显、历史补录和已知 Agent 自己的消息不唤醒

规范输入、ExecutionIntent 和 Native 附件引用在同一短事务接受。交互意图引用规范输入，不重复保存正文；后台意图只保留一份输入。调度从持久待办领取，内存队列只负责容量控制。一次性提醒走受控交付；需要推理的计划与普通交互使用同一个 AgentLoop

Task 是可修订的目标，状态为 `open / paused / completed / cancelled`，普通对话无需 Task。一次目标可由多个 Run 推进，失败 Run 不会把 Task 自动标记失败。同一 Task 只有一个推进者；不同目标和资源可以并行

任务结果带实际采用的 revision。旧结果可以保留，但不能完成新目标。`task.get` 显式读取并采用当前修订；模型修改目标或进度后，应重新读取再继续完成判断

运行中的同主体补充信息写入持久 Inbox，在模型步骤和工具动作之前采用。已经发起的 HTTP 生成不被改写；尚未发起的旧计划工具动作会先交还模型重新判断

`Tool.effect` 默认是 `external`，外部传输异常保存为未知结果，禁止自动重放。第一方 Task、Schedule、Context 与结束意图工具使用本地事务提交变更及回执；本地事务没有回执时，可以确认没有已提交的变更。只读工具可以声明 `read`

已确认工具回执与执行结果可以补齐缺失 Trace，不重新执行工作。确定的交付失败可显式请求交付重试，重试引用原结果，不重新调用模型；未知交付必须先核对

## 上下文与输出

Context Commit 只由显式保存产生，工具步骤留在 Trace 和 Operation 中。`context.refs` 只列版本入口，`context.read` 读取指定版本，`context.commit` 保存完整逻辑快照并检查 Ref CAS。读取旧版本不重放历史副作用

跨 Session 不隐式读取历史，同工作区私有目标仍按 Principal 隔离。全局装配按来源和版本去重，按完整消息或区块舍弃，Manifest 记录实际采用内容、字符成本和舍弃原因。后续模型请求连同工具结果仍受宿主全局上限约束

`runtime.finish` 保存以下独立输出意图，并直接结束当前推理机会：

- `silent`：完成本次工作，不发送消息
- `reply`：回复当前授权来源
- `notify`：向授权中固定的来源发送通知，发送时重新检查权限
- `waiting`：结束当前推理，由已创建的有效 Schedule 在未来继续

后台执行默认静默，定时唤醒不自动发送消息。模型提出通知内容，不能指定任意收件人。当前自主通知工具接受文本；交互中的工件继续走原有的选择、授权、上传与回执链路

## 维护与数据变化

`GET /admin/execution/retention-preview` 预览 `autonomy.retentionHours` 之外可清理的派生记录，默认 168 小时。清理不自动运行。管理员显式调用 `POST /admin/execution/retention-apply`，正文为 `{"confirmation":"delete-expired-derived-execution-records"}` 时，每次最多清理 100 个终结意图及其派生 Inbox、结果和已确认操作记录；未知操作及权威资源不在范围内

`POST /admin/execution/grants/:id/revoke` 撤销后续授权；`POST /admin/execution/schedules/:id/status` 使用 `expectedRevision` 修改计划状态；`POST /admin/execution/runs/:id/inbox` 提交有幂等键的补充信息；`POST /admin/execution/runs/:id/retry-delivery` 只接受确定发送失败的结果

所有维护入口沿用管理鉴权和脱敏边界，模型工具没有清理或撤权能力。有效授权下的执行记录不清理，以保留去重事实和累计额度；清理只涉及已过期或已撤销授权的派生记录

旧的 Native 会话映射在短事务中迁入 `conversation_sessions.workspace_id`，冲突会拒绝启动，不猜测应采用哪个绑定。映射迁移保留数据，并删除重复的映射表。Run 索引改为区分 Session 和 Workspace 的作用域键，后台 Run 不伪造 Session

executor Task、ConversationNode、Line Head、语义快照和旧分支投影 API 已删除，新库不再创建对应表。已有库中的旧表保留为停用数据，不参与执行、恢复或上下文装配；不会自动转换为新的目标或 Commit。需要全新数据库时，先停机并备份数据目录，再为新配置指定空数据目录。此次没有删除实际运行目录的持久数据
