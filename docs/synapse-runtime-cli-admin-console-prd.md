# Synapse Runtime CLI 与 Admin Console PRD

版本：v0.1  
状态：草案  
日期：2026-06-27  
技术栈：TypeScript / Node.js / HTTP / SSE 或 WebSocket / Ink TUI  

## 1. 背景

Synapse Runtime 当前的 CLI 与 Runtime Server 处于同一进程模型：用户通过 CLI 启动服务，并在同一个终端中查看运行状态与日志。这种方式适合本地开发和 MVP，但无法很好支持以下场景：

- 用户在多个项目目录中使用同一个 Runtime。
- CLI 作为控制端连接已经运行的本地服务。
- CLI 连接远程 VPS、NAS、内网机器上的 Runtime。
- 运行时服务长期常驻，CLI 随用随开。
- TUI 控制台查看日志、配置、Channel 状态，并执行管理命令。

因此需要将 CLI 与 Runtime Server 的职责拆开：Runtime Server 作为常驻服务暴露受控 Admin API，CLI/TUI 作为客户端连接服务并进行管理。

## 2. 产品目标

### 2.1 核心目标

构建 Synapse Runtime 的本地与远程控制能力，使用户可以在任意目录通过 CLI/TUI 连接一个已运行的 Runtime 服务，并完成状态查看、日志查看、配置查看与 Channel 管理。

目标结果：

- Runtime Server 可以独立常驻运行。
- CLI 可以绑定一个或多个 Runtime 服务。
- CLI 默认连接本地回环服务。
- TUI 控制台可以实时查看服务状态、日志、配置、Channel。
- 管理接口默认仅允许本地访问，远程访问必须显式启用并配置安全策略。

### 2.2 非目标

本阶段不做：

- 多租户 Web 管理后台。
- SaaS 控制台。
- 完整 RBAC 权限系统。
- 公网无认证 Admin API。
- 配置文件复杂可视化编辑器。
- 多 Runtime 集群调度。
- Agent 任务编排 UI。

## 3. 用户角色

| 角色 | 说明 | 核心诉求 |
|---|---|---|
| 本地开发者 | 在本机开发 Agent、Channel、工具 | 快速启动服务，随时打开控制台查看日志和配置 |
| 个人部署用户 | 在 PC、NAS、VPS 上运行 Runtime | Runtime 长期运行，CLI 在任意目录连接管理 |
| 远程维护者 | 通过 SSH/VPN/内网访问远程 Runtime | 安全连接远端服务，查看日志和启停 Channel |
| Runtime 维护者 | 维护 Synapse Runtime 本身 | 清晰的 CLI/Server 边界，可测试、可扩展 |

## 4. 产品原则

### 4.1 CLI 与服务分离

Runtime Server 负责运行 Agent、Channel、Webhook、权限、日志事件和 Admin API。

CLI 负责连接 Runtime Server，展示状态，发送管理命令。

CLI 不应默认直接持有 Runtime 内部对象，也不应只能在服务所在目录运行。

### 4.2 本地安全优先

Admin API 默认只监听本地回环地址：

```bash
127.0.0.1
```

默认情况下，远程机器无法访问 Admin API。

### 4.3 远程显式启用

远程管理必须显式配置：

- 监听 `0.0.0.0` 或指定内网地址。
- 配置 Admin Token。
- 配置允许的来源或远程地址。
- 推荐通过 HTTPS、SSH 隧道、VPN 或内网访问。

### 4.4 多 Profile 连接

CLI 支持多个服务 Profile，例如：

```text
local
nas
vps
prod
```

用户可以在任意目录通过 `--profile` 或当前默认 profile 连接对应服务。

### 4.5 TUI 是控制端，不是服务端

Claude Code / Codex 风格的 TUI 控制台应作为 CLI 客户端存在。

TUI 的数据来源是 Admin API 与日志事件流，而不是直接创建 Runtime Server。

## 5. 需求范围

### 5.1 第一阶段范围

第一阶段实现本地服务绑定与基础远程连接能力。

需要支持：

- `serve`：启动 Runtime Server。
- `connect`：将 CLI 绑定到某个 Runtime endpoint。
- `console`：打开 TUI 控制台连接服务。
- `status`：查看服务状态。
- `logs`：查看最近日志或实时日志。
- `channels`：查看 Channel 列表。
- `channel enable/disable`：启停配置中的 Channel。
- Admin API 默认只绑定 `127.0.0.1`。
- 远程访问要求 token。
- CLI profile 写入用户级配置。

### 5.2 第二阶段范围

第二阶段增强控制台体验。

可支持：

- TUI 内日志滚动、过滤、展开 metadata。
- `/config` 查看脱敏配置。
- `/channel set` 修改 Channel 字段。
- `/reload` 重新加载配置。
- `/shutdown` 停止服务。
- `console --spawn` 本地服务不存在时自动后台启动。
- SSE 或 WebSocket 实时日志流。

### 5.3 第三阶段范围

第三阶段支持更完整的远程与安全管理。

可支持：

- TLS 配置。
- CIDR allowlist。
- Token rotation。
- 只读 token 与管理 token。
- Audit log。
- 多服务 profile 导入导出。
- SSH tunnel 辅助命令。

## 6. 命令设计

### 6.1 服务端命令

启动 Runtime 服务：

```bash
synapse-runtime serve --config runtime.config.yaml
```

指定 Admin API：

```bash
synapse-runtime serve \
  --config runtime.config.yaml \
  --admin-host 127.0.0.1 \
  --admin-port 3766
```

远程管理模式：

```bash
synapse-runtime serve \
  --config /srv/synapse/runtime.config.yaml \
  --admin-host 0.0.0.0 \
  --admin-port 3766 \
  --admin-token-env SYNAPSE_ADMIN_TOKEN
```

### 6.2 连接命令

绑定本地服务：

```bash
synapse-runtime connect http://127.0.0.1:3766
```

绑定远程服务：

```bash
synapse-runtime connect https://runtime.example.com --token sk-xxx --profile prod
```

切换默认 profile：

```bash
synapse-runtime use prod
```

查看 profile：

```bash
synapse-runtime profiles
```

### 6.3 控制命令

```bash
synapse-runtime console
synapse-runtime console --profile prod
synapse-runtime status
synapse-runtime logs --tail 100
synapse-runtime logs --follow
synapse-runtime channels
synapse-runtime channel enable qq-official
synapse-runtime channel disable qq-official
synapse-runtime config show
synapse-runtime reload
```

### 6.4 自动启动本地服务

当本地服务未运行时，用户可以显式要求 CLI 拉起服务：

```bash
synapse-runtime console --spawn --config runtime.config.yaml
```

行为：

1. CLI 尝试连接当前 profile。
2. 如果连接失败并传入 `--spawn`，CLI 在后台启动本地 Runtime Server。
3. CLI 等待 `/admin/health` 成功。
4. CLI 更新本地 profile。
5. CLI 打开 TUI 控制台。

## 7. CLI Profile 设计

CLI 使用用户级配置保存连接信息。

建议路径：

```text
~/.synapse/cli.json
```

结构：

```json
{
  "current": "local",
  "profiles": {
    "local": {
      "endpoint": "http://127.0.0.1:3766",
      "token": ""
    },
    "prod": {
      "endpoint": "https://runtime.example.com",
      "token": "sk-xxx"
    }
  }
}
```

连接解析优先级：

1. `--endpoint`
2. `--profile`
3. `SYNAPSE_RUNTIME_URL`
4. `~/.synapse/cli.json` 中的 current profile
5. 默认 `http://127.0.0.1:3766`

Token 解析优先级：

1. `--token`
2. `SYNAPSE_RUNTIME_TOKEN`
3. profile token
4. 空 token

## 8. Admin API 设计

### 8.1 基础 API

| Method | Path | 说明 |
|---|---|---|
| GET | `/admin/health` | 健康检查 |
| GET | `/admin/status` | Runtime 状态 |
| GET | `/admin/config` | 获取脱敏后的有效配置 |
| GET | `/admin/channels` | 获取 Channel 列表 |
| PATCH | `/admin/channels/:id` | 修改 Channel 配置 |
| POST | `/admin/reload` | 重新加载配置 |
| GET | `/admin/logs?limit=100` | 获取最近日志 |
| GET | `/admin/events/stream` | 获取实时事件流 |
| POST | `/admin/shutdown` | 停止 Runtime |

### 8.2 状态响应示例

```json
{
  "ok": true,
  "runtime": {
    "mode": "local",
    "logLevel": "info",
    "startedAt": "2026-06-27T13:00:00.000Z"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3000
  },
  "admin": {
    "host": "127.0.0.1",
    "port": 3766
  },
  "channels": [
    {
      "id": "qq-official",
      "adapter": "qq-official",
      "enabled": true,
      "status": "connected"
    }
  ]
}
```

### 8.3 日志事件示例

```json
{
  "id": 42,
  "timestamp": "2026-06-27T13:00:00.000Z",
  "level": "info",
  "message": "Runtime channel reply sent.",
  "metadata": {
    "channelId": "qq-official",
    "messageId": "sent-1"
  }
}
```

## 9. 安全设计

### 9.1 默认安全策略

默认配置：

```yaml
admin:
  enabled: true
  host: 127.0.0.1
  port: 3766
  token: ""
  allowedOrigins:
    - http://127.0.0.1:3766
    - http://localhost:3766
  allowedRemoteAddresses:
    - 127.0.0.1
    - ::1
    - ::ffff:127.0.0.1
```

默认只允许本机 CLI 连接。

### 9.2 监听地址限制

当 `admin.host` 为 `127.0.0.1` 或 `::1` 时：

- 允许无 token 本地开发模式。
- 仍应校验 remote address 是否为回环地址。

当 `admin.host` 为 `0.0.0.0` 或非回环地址时：

- 必须配置 token。
- 必须显式配置 `allowedRemoteAddresses`，或传入明确的远程开启参数。
- 启动时应输出安全警告。

### 9.3 Origin 限制

Origin 用于防止浏览器页面跨站调用本地 Admin API。

规则：

- 如果请求带 `Origin`，必须匹配 `allowedOrigins`。
- 如果请求不带 `Origin`，按 CLI/API 客户端处理，继续校验 token 与 remote address。
- Origin 不能替代 token 与监听地址限制。

### 9.4 Token 认证

远程管理必须使用 Admin Token。

请求格式：

```http
Authorization: Bearer sk-xxx
```

安全要求：

- token 不应出现在日志中。
- `/admin/config` 必须脱敏 token、secret、apiKey、accessToken。
- token 错误返回 401。
- 来源不允许返回 403。

## 10. TUI 控制台设计

### 10.1 启动

```bash
synapse-runtime console
```

默认连接当前 profile。

### 10.2 界面信息

TUI 首页展示：

```text
Synapse Runtime Console

Status
  endpoint   http://127.0.0.1:3766
  mode       local
  logLevel   info
  uptime     00:12:32

Channels
  qq-official   connected   webhook   enabled

Logs
  21:42:10 INFO  server started
  21:42:13 INFO  webhook received
  21:42:14 INFO  reply sent

> /status
```

### 10.3 TUI 命令

```text
/help
/status
/logs
/logs warn
/config
/channels
/channel enable <id>
/channel disable <id>
/reload
/shutdown
/quit
```

## 11. 配置设计

Runtime 配置新增 admin 段：

```yaml
admin:
  enabled: true
  host: 127.0.0.1
  port: 3766
  token: ${SYNAPSE_ADMIN_TOKEN:-}
  allowedOrigins:
    - http://127.0.0.1:3766
    - http://localhost:3766
  allowedRemoteAddresses:
    - 127.0.0.1
    - ::1
    - ::ffff:127.0.0.1
```

兼容要求：

- 未配置 `admin` 时使用默认本地回环配置。
- 现有 `server` 配置继续用于业务 HTTP/Webhook 服务。
- Admin API 可以与业务服务同进程，但建议独立端口。

## 12. 技术实现建议

### 12.1 包结构

建议逐步拆分：

```text
packages/runtime-server      Runtime Server 与 Admin API
packages/runtime-cli         CLI / TUI 客户端
packages/runtime-admin-client Admin API client，可供 CLI 和测试复用
```

第一阶段可以先在 `runtime-server` 包内实现，待接口稳定后拆包。

### 12.2 通信协议

建议：

- 普通命令使用 HTTP JSON。
- 实时日志使用 SSE。
- 后续需要双向交互时再引入 WebSocket。

理由：

- HTTP JSON 易测试。
- SSE 对日志和事件流足够简单。
- WebSocket 可以后置，避免第一阶段复杂化。

### 12.3 日志存储

Runtime Server 内保留内存 ring buffer：

```text
默认 300 条
可配置 100 - 10000 条
```

日志仍可同时输出到 stdout/stderr 或结构化日志采集。

## 13. 验收标准

### 13.1 本地连接

- 启动 `synapse-runtime serve --config runtime.config.yaml` 后，CLI 可在任意目录执行 `synapse-runtime status`。
- 默认 endpoint 为 `http://127.0.0.1:3766`。
- 外部机器无法访问默认 Admin API。

### 13.2 Profile

- `connect` 可以写入 profile。
- `console --profile <name>` 可以连接指定服务。
- 未传 profile 时使用 current profile。

### 13.3 TUI

- `console` 可以展示状态、Channel、最近日志。
- `/logs` 可以查看日志。
- `/config` 展示脱敏配置。
- `/channel enable/disable` 可以修改服务配置或调用服务端管理接口。

### 13.4 安全

- `admin.host=0.0.0.0` 且无 token 时，服务拒绝启动。
- 带 `Origin` 的请求必须通过 allowlist。
- 非允许 remote address 返回 403。
- token 错误返回 401。
- 日志和配置输出中不泄露 secret/token/apiKey/accessToken。

## 14. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| Admin API 被误暴露 | 用户监听 `0.0.0.0` 但未配置安全策略 | 启动时强校验，远程必须 token |
| CLI 与 Server 版本不匹配 | 不同版本字段变化 | `/admin/status` 返回 protocolVersion |
| 配置写回破坏格式 | YAML 重新序列化会改变注释和格式 | 第一阶段限制写回范围，后续引入保留注释的编辑策略 |
| TUI 复杂度上升 | 全屏交互和表单容易膨胀 | 第一阶段只做命令式 TUI |
| 日志量过大 | 内存 buffer 不适合长期存储 | ring buffer 限制大小，持久化后置 |

## 15. 里程碑

### M1：Admin API 与本地 CLI

- 增加 `admin` 配置。
- 增加 `/admin/health`、`/admin/status`、`/admin/logs`、`/admin/channels`。
- CLI 支持 `status`、`logs`、`channels`。
- 默认只允许本地回环。

### M2：Profile 与 TUI

- CLI 支持 `connect`、`profiles`、`use`。
- TUI console 改为连接 Admin API。
- 支持实时日志流。

### M3：配置与 Channel 管理

- 支持 `/admin/config`。
- 支持 `channel enable/disable`。
- 支持 `reload`。
- 配置输出全量脱敏。

### M4：远程安全能力

- 支持 token。
- 支持 allowed origins。
- 支持 allowed remote addresses。
- 支持远程启动安全校验。

## 16. 开放问题

- Admin API 是否与业务 HTTP 服务共用端口，还是默认独立端口？
- CLI 包是否立即从 `runtime-server` 中拆出？
- 远程连接是否优先支持 HTTPS，还是推荐 SSH tunnel/VPN？
- 配置写回是否需要保留 YAML 注释？
- 是否需要 Windows 服务、systemd、launchd 等守护进程安装命令？
