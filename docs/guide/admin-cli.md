# Admin 与 CLI

服务端可执行包是 `@synapse/runtime-server`，终端客户端是 `@synapse/runtime-tui`；HTTP/SSE 客户端库为 `@synapse/runtime-client`。

## Runtime 命令

```bash
synapse-runtime start
synapse-runtime serve
synapse-runtime status
synapse-runtime logs
synapse-runtime channels
synapse-runtime channel enable <id>
synapse-runtime channel disable <id>
synapse-runtime reload
synapse-runtime shutdown
synapse-runtime connect <endpoint>
synapse-runtime profiles
synapse-runtime use <profile>
```

常用选项：

```bash
--config <path>
--env-file <path>
--admin-host <host>
--admin-port <port>
--admin-token-env <name>
--endpoint <url>
--token <token>
--profile <name>
--profile-config <path>
--tail <n>
```

## 独立 TUI

```bash
synapse-tui --endpoint http://127.0.0.1:3766
synapse-tui --profile prod
synapse-tui --spawn --runtime-entry apps/runtime/dist/cli.js --config examples/minimal.config.toml
```

TUI 默认读取连接 profile 或 `SYNAPSE_RUNTIME_URL` / `SYNAPSE_RUNTIME_TOKEN`。本地启动必须显式指定 `--runtime-entry`，可传 `--env-file`、`--workspace-config`、`--user-config` 给服务端；不能混用远程连接参数。

`/channel set <id> <key> <value>` 与 `/channel add-qq-official <id> appId=... appSecret=...` 修改连接目标的主配置文件，执行 `/reload` 后生效。服务端先校验，再原子写入；同进程并发编辑按文件排队。配置覆盖优先级不变，编辑主文件不会修改更高优先级来源。`/channel enable|disable <id>` 仅改变运行时状态。

退出远程 TUI 不会停止服务；退出 `--spawn` TUI 会关闭它启动的子进程。服务端配置须启用 Admin API。

## Admin API

Admin API 挂载在 `/admin`。

| Method | Path                            | 用途                                         |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/admin/health`                 | 健康检查                                     |
| GET    | `/admin/status`                 | Runtime、server、admin 和 channel 状态       |
| GET    | `/admin/config`                 | 脱敏后的 runtime config                      |
| GET    | `/admin/channels`               | Channel 摘要                                 |
| PATCH  | `/admin/channels/:id`           | 启用或禁用已配置 channel                     |
| PATCH  | `/admin/config/channels/:id`    | 校验并持久化主文件中的频道字段，需 reload    |
| POST   | `/admin/config/channels/:id`    | 校验并持久化新频道，需 reload                |
| GET    | `/admin/branches?sessionId=...` | 查询会话分支；省略参数时返回可恢复的活动分支 |
| GET    | `/admin/branches/:id`           | 查询单个分支                                 |
| GET    | `/admin/tasks?branchId=...`     | 查询分支任务；省略参数时返回未完成任务       |
| GET    | `/admin/tasks/:id`              | 查询单个任务                                 |
| POST   | `/admin/tasks/:id/cancel`       | 取消任务并持久化 cancelled Branch Result     |
| GET    | `/admin/logs?limit=100`         | 缓冲日志                                     |
| GET    | `/admin/events/stream`          | Server-sent log stream                       |
| POST   | `/admin/reload`                 | 从文件重新加载配置                           |
| POST   | `/admin/shutdown`               | 停止 runtime server                          |

## Admin 安全

如果 Admin API 暴露在非 loopback host 上，必须配置 `admin.token`。Server 还会检查 allowed origins 和 allowed remote addresses。

本地开发默认将 Admin API 绑定到 `127.0.0.1:3766`。
