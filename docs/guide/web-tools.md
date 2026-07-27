# 联网工具

Synapse Runtime 提供两个只读生产工具：

- `web.search`：通过 Brave Search 或自建 SearXNG 搜索公开网页
- `web.fetch`：读取公开 HTTP 或 HTTPS 页面并提取有限长度文本

两个工具都会通过 `ToolRuntime` 执行，因此自动继承运行上下文、权限判断、调用事件、幂等重放和 Agent 多步工具循环

典型执行链：

```text
用户问题
→ 模型调用 web.search
→ ToolRuntime 执行搜索
→ 模型选择来源并调用 web.fetch
→ ToolRuntime 抓取和提取正文
→ 模型根据来源生成回答
```

## 启用 Web Fetch

网络工具默认关闭

```toml
[tools.web]
enabled = true
timeoutMs = 15000
maxResponseBytes = 2000000
maxContentChars = 24000
maxRedirects = 5
allowPrivateNetwork = false

[permissions]
"network.web.fetch" = "allow"
```

只启用 `[tools.web]` 时会注册 `web.fetch`，不会注册 `web.search`

## 启用 Brave Search

```toml
[tools.web]
enabled = true

[tools.web.search]
provider = "brave"
apiKey = "${BRAVE_SEARCH_API_KEY}"

[permissions]
"network.web.search" = "allow"
"network.web.fetch" = "allow"
```

## 使用 SearXNG

```toml
[tools.web]
enabled = true

[tools.web.search]
provider = "searxng"
baseUrl = "https://search.example.com/search"
```

建议使用自己管理的 SearXNG 实例，避免依赖不稳定的公共实例

## 域名策略

```toml
[tools.web]
enabled = true
allowedDomains = ["github.com", "docs.github.com", "developer.mozilla.org"]
deniedDomains = ["private.example.com"]
```

规则如下：

- `deniedDomains` 始终优先
- `allowedDomains` 非空时只允许命中的域名及其子域名
- 每个重定向目标都会重新执行域名、DNS 和 IP 校验
- 默认拒绝回环、私网、链路本地、组播、保留地址和云 metadata 地址
- 默认拒绝 `file:`、`data:`、`ftp:`、`gopher:` 等非 HTTP 协议
- URL 不允许携带用户名或密码

`allowPrivateNetwork = true` 会放开私网保护，只适合明确受控的本地部署环境

## 内容边界

`web.fetch` 只执行 GET，并由 Runtime 设置固定请求头

模型不能提供：

- Cookie
- Authorization
- X-Api-Key
- 自定义认证请求头
- POST 请求体

支持的响应类型：

- HTML
- 纯文本
- Markdown
- JSON

HTML 会移除脚本、样式、模板和 SVG，再提取标题与可读文本

所有网页正文都会携带“不受信任外部内容”提示，不应把网页中的指令当成系统指令或用户授权

## 当前限制

- 不执行网页 JavaScript
- 不访问登录态页面
- 不保存 Cookie
- 不支持点击、截图或表单提交
- HTML 提取器是轻量实现，不等同于完整浏览器 Readability
- 搜索与抓取缓存尚未实现

## 设计参考

- [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference)
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
- [OpenCode Tool Sources](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/tool)
- [OpenAI Codex Config Schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
