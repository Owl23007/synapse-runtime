# Admin 与 CLI

可执行包是 `@synapse/runtime-server`。

## Runtime 命令

```bash
synapse-runtime start
synapse-runtime serve
synapse-runtime console
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
--spawn
--tail <n>
```

## Admin API

Admin API 挂载在 `/admin`。

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/admin/health` | 健康检查 |
| GET | `/admin/status` | Runtime、server、admin 和 channel 状态 |
| GET | `/admin/config` | 脱敏后的 runtime config |
| GET | `/admin/channels` | Channel 摘要 |
| PATCH | `/admin/channels/:id` | 启用或禁用已配置 channel |
| GET | `/admin/logs?limit=100` | 缓冲日志 |
| GET | `/admin/events/stream` | Server-sent log stream |
| POST | `/admin/reload` | 从文件重新加载配置 |
| POST | `/admin/shutdown` | 停止 runtime server |

## Admin 安全

如果 Admin API 暴露在非 loopback host 上，必须配置 `admin.token`。Server 还会检查 allowed origins 和 allowed remote addresses。

本地开发默认将 Admin API 绑定到 `127.0.0.1:3766`。
