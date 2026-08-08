# Synapse Runtime 模块化重构 PRD

版本：v0.3-architecture-refactor
目标迭代：下一迭代 / P1 基础设施重构
仓库：`Owl23007/synapse-runtime`
文档类型：PRD + 工程验收约束
核心目标：在不改变现有运行时行为、配置字段、Admin API 响应和 public import 路径的前提下，拆分已经过大的核心实现文件，降低后续 context、memory、tool calling、channel capability、Admin/TUI 扩展的回归风险。

---

## 1. 背景

当前 Synapse Runtime 的包边界方向整体正确：`runtime-core` 承担运行时编排，`runtime-server` 承担服务启动、配置加载、HTTP/Admin API、TUI/Console 等组合职责。

但实现层已经出现“大文件承载多个子系统”的问题：

- `packages/runtime-core/src/context.ts` 当前承担 identity、workspace、transcript、event process、context composer、output policy、SQLite storage、command response 等职责。文件内同时定义 `PlatformIdentity`、`SynapseIdentity`、`RuntimeActor`、`WorkspaceRef` 等上下文类型，以及 `IdentityResolverLite`、`WorkspaceResolverLite` 等解析实现。
- 同一文件中还定义 `TranscriptStore`、`InMemoryTranscriptStore`，并包含 transcript 幂等追加和 external message id 查询逻辑。
- `ContextComposer` 负责读取历史消息、过滤 TTL、裁剪 history、生成 prompt context metadata。
- `SqliteRuntimeContextStore` 同时实现 `TranscriptStore`、`EventProcessStore`、`WorkspaceStore`，并内置 SQLite 初始化、WAL、foreign keys、表结构、索引和迁移逻辑。
- `runtime-server/src/server/runtime-server.ts` 同时承担 RuntimeServer 生命周期、Gateway route、Admin API、Admin auth、config reload、runtime factory、channel manager、QQ webhook registry、SSE log stream 等职责。

这不是代码“坏”，而是系统复杂度已经从功能验证阶段进入了需要模块化治理的阶段。

---

## 2. 问题定义

当前主要问题不是功能缺失，而是维护风险上升。

### 2.1 变更半径过大

修改 ContextComposer 行为时，容易触碰 SQLite storage、transcript、workspace、command response 等无关逻辑。

修改 Admin API route 时，容易影响 RuntimeServer 生命周期、channel attach、reload、webhook registry 等无关逻辑。

### 2.2 回归风险不可控

runtime-core 当前事件链路涉及：

- channel event
- conversation route
- identity resolve
- workspace resolve
- transcript append
- context compose
- command response
- agent run
- permission decision
- response policy
- channel send
- assistant transcript append
- event process recovery

`RuntimeCore` 当前仍然可以作为编排中心保留，但它依赖的 context 子系统已经不适合继续集中在单文件中。

### 2.3 后续能力会被大文件拖慢

如果继续在当前结构上叠加：

- durable memory
- tool calling
- prompt budget
- passive reply window
- channel capability
- Admin API 扩展
- TUI runtime 管理
- 多 runtime / 多实例管理

每个功能都会被迫修改过多文件区域，导致 review 成本、测试成本和回归风险持续放大。

---

## 3. 用户与受益人

### 3.1 Runtime 维护者

负责 `runtime-core` 主链路、上下文、幂等、发送策略、agent loop 的维护者。

受益点：

- 能快速定位 context、transcript、workspace、output policy、SQLite 等职责。
- 新增上下文行为时不需要理解整个 SQLite store。
- 修改 RuntimeCore 编排时有更清晰的依赖边界。

### 3.2 Channel 开发者

负责 OneBot11、QQ Official、未来其他 channel adapter 的开发者。

受益点：

- channel enable/disable、webhook registry、send target、provider 映射逻辑更清楚。
- 修改 channel lifecycle 不需要进入 Admin auth 或 RuntimeServer route 细节。

### 3.3 Admin API / TUI 开发者

负责本地控制台、远程 Admin API、日志流、reload、shutdown、channel patch 的开发者。

受益点：

- 新增 Admin route 不需要修改 RuntimeServer 主类。
- SSE logs、auth guard、route DTO、channel patch 可以独立测试。
- TUI 后续可以稳定依赖 Admin API，而不是跟 RuntimeServer 内部实现耦合。

### 3.4 下游包使用者 / examples 使用者

包括从 `@synapse/runtime-core`、`@synapse/runtime-server` import 类型、类、工具函数的使用者。

受益点：

- public import 路径保持兼容。
- deep import 在迁移期不被突然破坏。
- package exports 不发生破坏性变化。

---

## 4. 本轮目标

本轮目标是结构治理，不是功能扩张。

### 4.1 必须达成

1. 拆分 `runtime-core/src/context.ts`，将 context 子系统拆成清晰模块。
2. 拆分 `runtime-server/src/server/runtime-server.ts`，将 Admin API、auth、runtime factory、channel manager、webhook registry、SSE logs 拆出。
3. 建立 public export surface 测试，确保现有导出路径不破坏。
4. 建立 runtime-core context 行为回归测试。
5. 建立 runtime-server Admin/lifecycle 行为回归测试。
6. 建立 SQLite 旧库 fixture migration 测试。
7. 保持所有现有 runtime 行为、配置字段、API 响应字段不变。
8. 最后用 `oxlint`、`fmt`、typecheck、test 做收口验收。

### 4.2 不做

本轮不做：

- 不新增 channel。
- 不实现 tool calling。
- 不改变 conversation trigger 策略。
- 不改变 Admin API path。
- 不改变 Admin API response schema。
- 不改变 config schema。
- 不改变 Runtime reload 语义。
- 不改变 SQLite schema 语义，除非只是为了保持旧库兼容。
- 不把 `console/controller.ts` 纳入本轮 P1 必交范围。

---

## 5. 成功指标

本次重构成功不以“拆文件数量”为唯一标准，而以以下结果验收：

1. 后续新增 `ContextComposer` 行为时，不需要修改 SQLite storage 文件。
2. 后续新增 Admin API route 时，不需要修改 `RuntimeServer` 主类。
3. 现有 public import 路径 100% 兼容。
4. 现有 examples、runtime-server、测试代码使用过的 deep import 路径不被破坏。
5. Runtime reload、channel enable/disable、QQ webhook、SSE logs、Admin auth 有回归测试覆盖。
6. SQLite 旧库 fixture 可以被新版本初始化逻辑重复打开，且 migration 幂等。
7. 重构 PR 不引入新的 runtime 行为、配置字段或 API 响应字段。
8. 拆分后无新增循环依赖。
9. `pnpm -r test`、`pnpm -r typecheck`、`pnpm oxlint`、`pnpm fmt:check` 全部通过。
10. 文件体积下降只是辅助指标；更重要的是职责单一、依赖方向清晰、测试覆盖充分。

---

## 6. 优先级与里程碑

### P0：本轮必须完成

1. 冻结 public export surface。
2. 冻结 runtime-core context 行为。
3. 拆分 context 纯类型、纯函数、output policy。
4. 拆分 transcript / event-process in-memory store。
5. 拆分 ContextComposer、identity、workspace。
6. 拆分 SQLite storage，并增加旧库 fixture 测试。

### P1：本轮应完成，但可拆成独立 PR

1. 冻结 runtime-server Admin/lifecycle 行为。
2. 拆分 Admin auth / routes / SSE logs。
3. 拆分 runtime factory / channel manager / webhook registry。
4. RuntimeServer 主类瘦身。

### P2：本轮不强制

1. 拆分 `console/controller.ts`。
2. Console controller 只在 runtime-core/server 都完成后再处理。
3. 如果 scope 失控，P2 直接移出本轮。

---

## 7. 依赖关系

### 7.1 必须先做 public export surface test

所有拆分之前，必须先冻结 public export surface。否则拆分过程中很容易出现：

- 同名类型重复导出。
- 类型导出存在，但运行时导出缺失。
- ESM `.js` import 路径与 TS 源路径不一致。
- package exports 没同步。
- 下游 deep import 被破坏。

### 7.2 runtime-core 拆分先于 runtime-server factory 拆分

`runtime-server` 的 `runtime-factory.ts` 会依赖 runtime-core 的导出结构。如果 runtime-core export 尚未稳定，server 侧拆分会产生二次返工。

### 7.3 SQLite 拆分必须晚于 context 类型拆分

SQLite store 实现依赖 `TranscriptStore`、`EventProcessStore`、`WorkspaceStore` 等抽象。必须先把这些抽象拆清楚，再拆 SQLite。

### 7.4 Admin routes 拆分先于 channel manager 拆分

Admin route 里会调用 channel patch / reload / status summary。先把 routes handler 边界拆出，再把底层 channel manager 抽象出去，风险更低。

---

## 8. 目标模块结构

### 8.1 runtime-core 目标结构

```text
packages/runtime-core/src/
  index.ts
  context.ts                         # 兼容 shim，短期保留
  runtime-core.ts                    # 可选，后续再从 index.ts 拆 RuntimeCore 主类

  context/
    index.ts
    types.ts                         # ConversationType / RuntimeActor / WorkspaceRef
    identity.ts                      # IdentityResolver / IdentityResolverLite / anonymousActor
    workspace.ts                     # WorkspaceResolver / WorkspaceResolverLite / defaultWorkspace
    session.ts                       # buildSessionId / buildSourceEventId / normalizeMessageId
    composer.ts                      # ContextComposer
    time.ts                          # formatZonedTimestamp
    history.ts                       # trimHistory / TTL / max message strategy

  transcript/
    index.ts
    types.ts                         # TranscriptMessage / TranscriptStore
    in-memory.ts                     # InMemoryTranscriptStore

  event-process/
    index.ts
    types.ts                         # EventProcessState / EventProcessStore
    in-memory.ts                     # InMemoryEventProcessStore

  output/
    index.ts
    policy.ts                        # OutputPolicyResolver / ResponsePolicy / applyTextPolicy

  commands/
    index.ts
    command-response.ts              # /whoami /workspace /memory command response

  storage/
    sqlite/
      index.ts
      runtime-context-store.ts       # SqliteRuntimeContextStore facade
      schema.ts                      # CREATE TABLE / indexes
      migrations.ts                  # ensureColumn / migration helpers
      transcript-store.ts            # transcript SQL operations
      event-process-store.ts         # event_process SQL operations
      workspace-store.ts             # workspace SQL operations
```

### 8.2 runtime-server 目标结构

```text
packages/runtime-server/src/server/
  runtime-server.ts                  # RuntimeServer facade
  runtime-lifecycle.ts               # start / stop / reload / replace config
  runtime-factory.ts                 # create RuntimeCore + context store
  channel-manager.ts                 # attach / enable / disable / disconnect / summary
  webhook-registry.ts                # QQ Official webhook route registry

  admin/
    routes.ts                        # registerAdminRoutes(app, deps)
    auth.ts                          # authorizeAdminRequest / validateAdminSecurity
    dto.ts                           # ChannelAdminPatch / response DTO
    channel-admin.ts                 # patch channel enabled / disabled
    logs-sse.ts                      # streamLogEvents / writeSseLogEntry

  gateway/
    routes.ts                        # /health + webhook gateway setup
```

### 8.3 console 目标结构，P2 可选

```text
packages/runtime-server/src/console/
  controller.ts                      # facade
  local-runtime-controller.ts         # spawn / stop local runtime
  remote-admin-controller.ts          # refresh / reload / shutdown / logs
  state-reducer.ts                   # state update
  selectors.ts                       # derived display state
```

---

## 9. 模块依赖方向约束

### 9.1 runtime-core

1. `context/composer.ts` 可以依赖：

   - transcript types
   - identity/workspace types
   - history helpers
   - time helpers

2. `context/composer.ts` 不得依赖：

   - SQLite concrete store
   - RuntimeCore
   - runtime-server

3. `output/policy.ts` 不得依赖：

   - RuntimeCore
   - ContextComposer
   - SQLite
   - command response

4. `commands/command-response.ts` 不得依赖：

   - SQLite 具体实现
   - runtime-server
   - channel adapter

5. `storage/sqlite/*` 可以实现：

   - `TranscriptStore`
   - `EventProcessStore`
   - `WorkspaceStore`

6. 业务层不得反向依赖 `storage/sqlite/*`。
   允许组合层注入 SQLite store，但 composer、policy、identity、workspace 不允许 import sqlite 子模块。

### 9.2 runtime-server

1. `runtime-factory.ts` 可以依赖：

   - runtime-core
   - runtime-config
   - runtime-conversation
   - runtime-permission
   - runtime-tool-runtime
   - agent factory

2. `runtime-server.ts` 只能作为 facade 依赖：

   - lifecycle
   - channel manager
   - admin routes
   - gateway routes

3. `runtime-server/admin/*` 不得直接创建 RuntimeCore。

4. `admin/auth.ts` 不得依赖：

   - channel manager
   - runtime factory
   - webhook registry

5. `channel-manager.ts` 不得处理：

   - Admin auth
   - CORS
   - SSE socket
   - config file loading

6. `webhook-registry.ts` 不得处理：

   - Admin API route
   - Runtime reload
   - Admin token 校验

---

## 10. Public Export 兼容需求

### R1. Public export surface 必须冻结

要求：

1. 增加 public export snapshot test。
2. 覆盖 `@synapse/runtime-core` 当前所有公开导出。
3. 覆盖 `@synapse/runtime-server` 当前所有公开导出。
4. 覆盖 runtime-server 或 examples 历史使用过的 deep import。
5. 检查 `package.json` exports 是否需要新增 subpath。
6. 不得删除旧 subpath。
7. 如果出现同名 re-export 冲突，优先保持旧导出语义。

建议测试：

```text
tests/export-surface/runtime-core.exports.test.ts
tests/export-surface/runtime-server.exports.test.ts
tests/export-surface/deep-import.compat.test.ts
```

验收：

- 类型导出和运行时导出都必须存在。
- ESM `.js` 路径可正常解析。
- `context.ts` 可作为 shim 保留。
- `export * from "./context.js"` 的旧路径继续有效。
- package exports 不出现破坏性变更。

---

## 11. SQLite 旧库兼容需求

### R2. SQLite fixture migration 必须覆盖旧库

当前 `SqliteRuntimeContextStore` 在构造时创建目录、打开 better-sqlite3、启用 WAL、启用 foreign keys，并执行 migration。

要求：

1. 准备至少一个 pre-refactor SQLite fixture。
2. fixture 代表当前线上/本地已有库结构。
3. 在 fixture 上执行新版本初始化逻辑。
4. 验证 migration 幂等。
5. 验证重复初始化不异常。
6. 验证 WAL、foreign_keys、索引、nullable/default 行为不变。
7. 验证旧 transcript 数据读取结果不变。
8. 验证旧 event_process 数据读取结果不变。
9. 验证旧 workspace binding 数据读取结果不变。
10. 验证 `external_message_id` 查询行为不变。
11. 验证 `conversation_type = channel` 兼容行为。
12. migration helper 拆分后不得产生重复 schema side effect。

建议 fixture：

```text
packages/runtime-core/test/fixtures/sqlite/
  pre-refactor-runtime-context.sqlite
```

建议测试：

```text
packages/runtime-core/test/sqlite-runtime-context-store.migration.test.ts
```

验收：

- 新建空库测试通过。
- 旧 fixture 库测试通过。
- 重复初始化同一个库测试通过。
- 旧数据读取结果与预期一致。
- migration helper 拆分后行为与拆分前一致。

---

## 12. Runtime reload 失败语义

### R3. 本轮不改变 reload 语义

当前 `#replaceRuntimeConfig` 的顺序是：

1. disconnect all channels
2. close context store
3. 替换 config
4. 创建新 runtime
5. 清空 QQ Official routes
6. attach channels
7. connect channels

对应代码中 `#replaceRuntimeConfig` 先调用 `#disconnectAllChannels()` 和 `#closeContextStore()`，再替换 config、重建 runtime、重新 attach/connect channels。

本轮明确：

1. 不改成事务式 reload。
2. 不改成“先创建新 runtime，成功后关闭旧 runtime”的保守方案。
3. 拆分后必须保持当前 reload 语义。
4. 如果 reload 失败后服务不可用，这是当前行为限制，本轮只测试和记录，不借重构修改。

后续可以单独立项：

```text
feat(runtime-server): make runtime reload transactional
```

后续事务式 reload 目标语义：

1. 先加载 next config。
2. 创建 next runtime。
3. 尝试 attach/connect next channels。
4. 成功后再关闭 old runtime。
5. 失败时 old runtime 继续服务。

但该行为变更不进入本轮。

验收：

- 拆分前后 reload 行为一致。
- reload 失败测试能记录当前限制。
- 不因为重构引入新的半初始化状态。

---

## 13. Admin Auth 与 SSE 安全测试

### R4. Admin Auth 测试必须覆盖普通 route 与 SSE route

当前 Admin auth 包含 origin、remote address、bearer token 校验。

测试必须覆盖：

1. 没有 token。
2. token 格式错误。
3. token 正确但 origin 不允许。
4. token 正确但 remote address 不允许。
5. loopback host 下允许无 token 的本地开发模式。
6. 非 loopback host 且无 admin.token 时启动失败。
7. CORS preflight 是否走 auth，行为必须明确。
8. SSE `/admin/events/stream` 连接必须与普通 Admin route 使用相同 auth 规则。
9. 反向代理下 `x-forwarded-for` 是否信任必须明确。

本轮建议：

- 默认不信任 `x-forwarded-for`。
- 继续以 `request.ip` 作为 remote address 判断来源。
- 如果后续要支持反向代理 trusted proxy，单独立项，不在本轮通过重构偷偷改变安全语义。

验收：

- Admin JSON route auth 测试通过。
- Admin SSE route auth 测试通过。
- 非 loopback 无 token 启动失败测试通过。
- 不新增隐式 trusted proxy 行为。

---

## 14. 实施计划

### Phase 0：Public Export 安全网

任务：

1. 增加 public export snapshot test。
2. 增加 deep import compatibility test。
3. 检查 package exports。
4. 记录当前 public runtime exports。
5. 记录当前 public type exports。

产出：

- `runtime-core.exports.test.ts`
- `runtime-server.exports.test.ts`
- `deep-import.compat.test.ts`

验收：

- 拆分前测试通过。
- 后续每个 refactor PR 都必须继续通过。

回滚策略：

- 如果 export snapshot 失败，停止拆分。
- 不进入 Phase 1。
- 优先修复测试基线，而不是改业务代码。

---

### Phase 1：冻结 runtime-core context 行为

任务：

1. 测试 `buildSessionId`。
2. 测试 `buildSourceEventId`。
3. 测试 `normalizeMessageId`。
4. 测试 `ContextComposer`：

   - history TTL
   - maxHistoryChars
   - timezone
   - trigger metadata

5. 测试 `ResponsePolicy`：

   - markdown 清理
   - code block 省略
   - maxChars
   - expand hint

6. 测试 `InMemoryTranscriptStore`：

   - sourceEventId 幂等
   - externalMessageId 查询

7. 测试 `InMemoryEventProcessStore`：

   - begin 幂等
   - update 状态变化

8. 测试 `SqliteRuntimeContextStore`：

   - append/listRecent
   - event process begin/update
   - workspace resolve
   - external message lookup

验收：

- 所有测试在拆分前通过。
- 测试覆盖当前行为，而不是理想行为。

回滚策略：

- 如果测试暴露当前行为不一致，先记录现状。
- 本轮不修行为，除非是测试错误。
- 行为修复另开 issue。

---

### Phase 2：拆分 runtime-core context 纯类型与纯函数

任务：

1. 提取 `context/types.ts`。
2. 提取 `transcript/types.ts`。
3. 提取 `event-process/types.ts`。
4. 提取 `context/session.ts`。
5. 提取 `context/time.ts`。
6. 提取 `context/history.ts`。
7. 提取 `output/policy.ts`。

验收：

- public export 不变。
- runtime-core tests 不变。
- 无循环依赖。
- `context.ts` 可作为 re-export shim。

回滚策略：

- 任一测试失败，回退本 phase 对应 commit。
- 不与 SQLite 拆分混在一个 commit 中。

---

### Phase 3：拆分 runtime-core 业务模块

任务：

1. 提取 `context/identity.ts`。
2. 提取 `context/workspace.ts`。
3. 提取 `context/composer.ts`。
4. 提取 `transcript/in-memory.ts`。
5. 提取 `event-process/in-memory.ts`。
6. 提取 `commands/command-response.ts`。

验收：

- `RuntimeCore` import 路径更新，但 public export 不变。
- context 行为测试通过。
- command response 行为不变。
- composer 不依赖 SQLite。

回滚策略：

- 单模块失败时只回滚该模块提取。
- 不影响 Phase 2 已完成拆分。

---

### Phase 4：拆分 SQLite storage

任务：

1. 提取 `storage/sqlite/runtime-context-store.ts`。
2. 提取 `storage/sqlite/schema.ts`。
3. 提取 `storage/sqlite/migrations.ts`。
4. 可选提取：

   - `transcript-store.ts`
   - `event-process-store.ts`
   - `workspace-store.ts`

验收：

- 新建空库测试通过。
- 旧 fixture 库测试通过。
- 重复初始化同一数据库测试通过。
- WAL、foreign_keys、索引行为不变。
- `SqliteRuntimeContextStore` public export 不变。
- RuntimeServer 创建 context store 的行为不变。

回滚策略：

- 如果 migration fixture 失败，整段 SQLite 拆分回滚。
- 不允许带着不确定 migration 风险进入 server 拆分。

---

### Phase 5：冻结 runtime-server Admin/lifecycle 行为

任务：

1. 测试 `/health`。
2. 测试 `/admin/health`。
3. 测试 `/admin/status`。
4. 测试 `/admin/config`。
5. 测试 `/admin/channels`。
6. 测试 `/admin/logs`。
7. 测试 `/admin/events/stream`。
8. 测试 `/admin/reload`。
9. 测试 `/admin/shutdown`。
10. 测试 channel enable/disable patch。
11. 测试 QQ webhook route enable/disable。
12. 测试 Admin auth 全场景。

验收：

- 拆分前测试通过。
- 测试记录当前 reload 失败语义。
- SSE route 与普通 route auth 行为一致。

回滚策略：

- 如果现有行为难以测试，先补测试 seam。
- 不直接改 RuntimeServer 行为。

---

### Phase 6：拆分 Admin auth / routes / SSE

任务：

1. 提取 `admin/auth.ts`。
2. 提取 `admin/dto.ts`。
3. 提取 `admin/logs-sse.ts`。
4. 提取 `admin/routes.ts`。
5. RuntimeServer 只调用 `registerAdminRoutes()`。

验收：

- Admin API 路径不变。
- 状态码不变。
- 响应字段不变。
- Auth 行为不变。
- SSE 行为不变。

回滚策略：

- 如果 route 响应 diff，回滚该 phase。
- 不同时修改 channel manager。

---

### Phase 7：拆分 runtime factory / channel manager / webhook registry

任务：

1. 提取 `runtime-factory.ts`。
2. 提取 `channel-manager.ts`。
3. 提取 `webhook-registry.ts`。
4. RuntimeServer 主类瘦身。
5. 保持 reload 顺序不变。

验收：

- RuntimeServer 主类不直接包含 Admin route handler 细节。
- RuntimeServer 主类不直接包含 SSE socket 写入细节。
- RuntimeServer 主类不直接包含完整 RuntimeCore 创建细节。
- channel enable/disable 行为不变。
- QQ Official webhook route 行为不变。
- reload 行为不变。

回滚策略：

- 如果 reload/channel/webhook 任一行为失败，回滚整个 Phase 7。
- 不允许在 Phase 7 中顺手修改 reload 语义。

---

### Phase 8：oxlint / fmt / typecheck / test 收口

任务：

1. 跑完整测试。
2. 跑 typecheck。
3. 跑 oxlint。
4. 跑 fmt check。
5. 清理未使用 export。
6. 清理临时 shim，但只删除确认无下游依赖的 shim。
7. 更新 architecture docs。

建议命令：

```bash
pnpm -r test
pnpm -r typecheck
pnpm oxlint
pnpm fmt:check
```

如果当前 package scripts 还没有统一命令，应补齐：

```json
{
  "scripts": {
    "lint": "oxlint .",
    "fmt": "prettier --write .",
    "fmt:check": "prettier --check ."
  }
}
```

验收：

- 所有命令通过。
- 不存在 lint-only 改动混入核心重构 commit。
- 格式化改动建议单独 commit，避免污染 review。

回滚策略：

- 如果 oxlint 暴露大量历史问题，本轮只修重构触碰文件。
- 全仓历史 lint 清理单独立项。
- fmt 大面积变更单独 commit，不和逻辑拆分混在一起。

---

## 15. 文件体积指标

文件体积目标是辅助指标，不作为唯一验收。

建议目标：

- `runtime-core/src/context.ts`：最终 ≤ 50 行，或仅作为 re-export shim。
- `runtime-server/src/server/runtime-server.ts`：最终 ≤ 200 行。
- 单个普通业务模块：建议 ≤ 300 行。
- SQLite facade：可短期 ≤ 500 行，但 schema/migration 必须独立。

例外规则：

如果单文件超过建议行数，但满足以下条件，可以接受：

1. 职责单一。
2. 测试充分。
3. 无循环依赖。
4. PR 中解释为什么暂不继续拆分。

禁止为了追求行数而过度拆分。

---

## 16. Issue 拆分

### P0-1：test(exports): 冻结公开导出面

范围：

- runtime-core 公开导出
- runtime-server 公开导出
- 深层导入兼容性
- package exports 配置检查

完成标准：

- 导出快照测试通过。
- 运行时导出和类型导出均覆盖。
- 旧 import 路径不破坏。

---

### P0-2：test(runtime-core): 冻结 context 行为

范围：

- session/source id 生成
- `ContextComposer` 行为
- `ResponsePolicy` 行为
- transcript 存储
- event process 存储
- workspace 解析
- SQLite context 存储

完成标准：

- 拆分前测试全绿。
- 行为基线明确。

---

### P0-3：refactor(runtime-core): 拆分 context 类型、辅助函数和 output policy

范围：

- context 类型
- transcript 类型
- event-process 类型
- session/time/history 辅助函数
- output policy 输出策略

完成标准：

- 公开导出不变。
- 无循环依赖。
- 测试通过。

---

### P0-4：refactor(runtime-core): 拆分 identity、workspace、composer 和内存存储

范围：

- identity 解析
- workspace 解析
- context composer
- 内存版 transcript store
- 内存版 event process store
- command response 命令响应

完成标准：

- context composer 不依赖 SQLite。
- command response 不依赖 SQLite 具体存储实现。
- RuntimeCore 行为不变。

---

### P0-5：refactor(runtime-core): 提取 SQLite storage 并增加 fixture migration 测试

范围：

- SQLite runtime context store
- schema 表结构
- migration 迁移
- 旧库 fixture migration

完成标准：

- 空库通过。
- 旧库 fixture 通过。
- 重复初始化通过。
- 公开导出不变。

---

### P1-1：test(runtime-server): 冻结 Admin API 生命周期和 webhook 行为

范围：

- health 健康检查
- admin status/config/channels/logs/SSE/reload/shutdown 接口
- auth 认证
- channel patch 更新
- webhook registry 注册表

完成标准：

- 拆分前测试全绿。
- reload 当前语义被测试覆盖。

---

### P1-2：refactor(runtime-server): 提取 Admin auth、routes 和 SSE logs

范围：

- admin/auth 模块
- admin/routes 模块
- admin/dto 模块
- admin/logs-sse 模块

完成标准：

- Admin API 路径、状态码和响应字段不变。
- SSE 认证行为不变。
- RuntimeServer 不包含 Admin route handler 细节。

---

### P1-3：refactor(runtime-server): 提取 runtime factory、channel manager 和 webhook registry

范围：

- runtime-factory 模块
- channel-manager 模块
- webhook-registry 模块
- runtime-server facade

完成标准：

- RuntimeServer ≤ 200 行作为参考目标。
- channel 启停行为不变。
- reload 不变。
- webhook 行为不变。

---

### P2：refactor(console): 拆分 controller 状态和远程操作

范围：

- local-runtime-controller 模块
- remote-admin-controller 模块
- state-reducer 模块
- selectors 模块

完成标准：

- 不进入本轮 P1 必交范围。
- 仅在 P0/P1 完成后处理。
- 如果范围失控，直接移出本轮。

---

## 17. 回滚策略总则

1. 每个 Phase 独立 PR。
2. 测试冻结 PR 先合并，再做重构 PR。
3. runtime-core 与 runtime-server 不混在一个大 PR。
4. SQLite 拆分独立 PR。
5. fmt 大面积改动独立 PR。
6. oxlint 历史问题清理独立 PR。
7. 任一 Phase 出现行为回归，回滚该 Phase，不回滚之前已通过的测试冻结和纯类型拆分。
8. 不允许在重构 PR 中“顺手修行为”。

---

## 18. 最终验收清单

### 行为验收

- [ ] RuntimeCore 事件处理链路行为不变。
- [ ] ContextComposer 输出结构不变。
- [ ] ResponsePolicy 输出行为不变。
- [ ] TranscriptStore 行为不变。
- [ ] EventProcessStore 行为不变。
- [ ] WorkspaceStore 行为不变。
- [ ] SQLite 旧库 fixture migration 通过。
- [ ] Admin API route 行为不变。
- [ ] Admin Auth 行为不变。
- [ ] SSE logs 行为不变。
- [ ] Runtime reload 行为不变。
- [ ] Channel enable/disable 行为不变。
- [ ] QQ Official webhook 行为不变。

### 兼容验收

- [ ] public export snapshot 通过。
- [ ] deep import compatibility test 通过。
- [ ] package exports 没有破坏性删除。
- [ ] ESM `.js` import 路径可正常解析。
- [ ] 同名 re-export 冲突已处理。

### 工程验收

- [ ] 无新增循环依赖。
- [ ] RuntimeServer 主类只保留 facade 职责。
- [ ] ContextComposer 不依赖 SQLite。
- [ ] OutputPolicy 不依赖 RuntimeCore。
- [ ] Admin routes 不直接创建 RuntimeCore。
- [ ] Channel manager 不处理 Admin auth。
- [ ] 文件体积达到参考目标，或 PR 中解释例外原因。

### 命令验收

- [ ] `pnpm -r test`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm oxlint`
- [ ] `pnpm fmt:check`

---

## 19. 结论

本轮重构的核心不是“把大文件拆小”，而是把已经存在的系统职责边界固化为模块边界。

`runtime-core/src/context.ts` 当前已经成为 context 子系统聚合文件；`runtime-server/src/server/runtime-server.ts` 当前已经成为 server、Admin API、runtime factory、channel manager、webhook registry、SSE logs 的聚合文件。继续在这些文件中叠加功能，会让后续每次新增 context、memory、tool calling、Admin route、channel capability 都变成高回归风险修改。

因此下一迭代应采用：

1. public export 安全网先行；
2. runtime-core 行为冻结；
3. context 子系统拆分；
4. SQLite fixture migration 验收；
5. runtime-server 行为冻结；
6. Admin/runtime/channel/webhook 拆分；
7. console 降权到 P2；
8. 最后 oxlint / fmt / typecheck / test 收口。

本轮完成后，Synapse Runtime 才更适合继续推进真正的 agent loop、长期记忆、工具调用、更多 channel capability 和 Admin/TUI 扩展。
