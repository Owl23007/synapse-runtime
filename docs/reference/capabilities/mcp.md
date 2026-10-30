# 远程 MCP

tool-mcp 使用官方 v2 Client 与 Streamable HTTP，负责握手、发现、调用、取消和关闭，不拥有 Workspace 或 Skill 安装模型。

```toml
[mcp]
allowedHosts = ["example.org"]
privateHosts = []
timeoutMs = 30000
maxResponseBytes = 2097152

[[mcp.servers]]
id = "example-http"
transport = "streamable-http"
url = "https://example.org/mcp"
enabled = true
authTokenEnv = "SYNAPSE_MCP_EXAMPLE_TOKEN"
```

凭据设置在部署环境，配置只保存变量名。配置连接会登记为安装快照，仍需为 Workspace 启用。Registry 安装只采用所选版本的远程 HTTP 地址，主机必须在 allowedHosts；私网再由 privateHosts 精确批准。

工具身份包含逻辑连接与配置摘要，用户权限动作保持逻辑身份稳定。配置连接的动作例如 `mcp.example-http.call`，Connections 页面显示实际所需权限。Workspace 启用不会代替用户权限允许。

工具列表与实际调用均检查 Workspace；调用参数按发现的 JSON Schema 验证。连接页显示状态、稳定错误码、协议、远端版本和工具摘要。Schema 变化要求显式重新发现，历史 Run 仍保留原观察摘要。远端代码无法完全锁定或回滚。

客户端禁用自动交互轮次与传输重连重试。非只读调用失去可靠结果时标记 outcome uncertain，恢复不会重放。Resources/Prompts 不强行变成 Tools；本地 stdio 与旧式 SSE 延后处理。
