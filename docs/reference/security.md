# 安全

## 凭据处理

Runtime config 支持环境变量展开。Provider API key、QQ credential 和 NapCat access token 应放在环境变量或本地 env 文件中。

Admin API 的 config endpoint 会通过 `redactConfig` 返回脱敏配置。

## Admin API 暴露

Admin API 默认绑定 loopback：

```toml
[admin]
host = "127.0.0.1"
port = 3766
```

如果 Admin API 绑定到非 loopback host，启动时必须配置 `admin.token`。Server 还会检查：

- `allowedOrigins`
- `allowedRemoteAddresses`
- 已配置时的 bearer token

## 权限边界

Channel send 和 tool call 都会经过 permission engine。静态权限引擎支持：

- `allow`
- `confirm`
- `deny`
- `sandbox`
- `rate_limit`

当前 runtime send actions：

- private target：`channel.qq.send_private_message`
- group target：`channel.qq.send_group_message`
- channel target：`channel.qq.send_channel_message`

## 上下文边界

P0 上下文实现避免跨 session 混入：

- 群聊 prompt 只读取当前 group session history
- 私聊 prompt 只读取当前 private session history
- 未触发的群消息不会写入 transcript
- recent history 查询过滤 `deleted_at IS NULL`

## 运维建议

- NapCat 等 community/unofficial adapter 建议使用 `riskLevel = "high"`。
- 官方 bot 集成建议使用 `riskLevel = "low"`。
- 除非已经明确启用 memory command 行为和 ACL 要求，否则保持 `memory.enableDurableMemory = false`。
