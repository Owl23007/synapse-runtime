# 配置

Runtime 配置由 `@synapse/runtime-config` 加载。Loader 支持 TOML、YAML 和 JSON；仓库内的示例文件是 `examples/runtime.config.toml`。

## 顶层配置段

```toml
[runtime]
[server]
[admin]
[context]
[memory]
[locale]
[prompts]
[presentation]
[tools.web]
[tools.web.search]
[agent]
[conversation.privateTrigger]
[conversation.groupTrigger]
[conversation.contextPolicy]
[channels."<channel-id>"]
[permissions]
```

联网能力默认关闭，启用方式、搜索提供商和安全边界见[联网工具](./web-tools.md)

## Runtime

```toml
[runtime]
mode = "local"
dataDir = "~/.synapse/runtime"
logLevel = "info"
```

- `mode`：`local`、`attached` 或 `hosted`
- `dataDir`：本地运行时数据目录，包含 `runtime-context.sqlite`。默认是用户目录下的 `~/.synapse/runtime`；`~` 会展开为当前用户目录，显式相对路径会按配置文件所在目录解析。
- `logLevel`：`trace`、`debug`、`info`、`warn`、`error` 或 `fatal`

## Context

```toml
[context]
enabled = true
maxHistoryChars = 6000
```

启用后，`runtime-server` 会在 `runtime.dataDir` 下创建 `runtime-context.sqlite`，并将其注入为 transcript store、idempotency store 和 workspace store。

```toml
[context]
strategy = "default"

[context.cache]
enabled = true
```

- `strategy`：上下文合成策略标识。它会作为 Prompt Registry 的受控变量传入，不应以每次请求都变化的内容替代稳定规则。
- `context.cache.enabled`：允许 Runtime 按稳定前缀组织模型输入。Provider 是否实际命中 Prefix KV Cache 取决于其适配器和服务端能力；关闭后不应假设存在缓存收益。

## Locale

```toml
[locale]
default = "zh-CN"
catalogPath = "resources/locales.zh-CN.yaml"
```

错误逻辑使用稳定的错误码和 message key，展示边界再根据 `locale.default` 渲染用户可见文本。P0 内置并提供 `zh-CN` 示例；自定义 catalog 可覆盖或补充 message key。模板变量使用单花括号，例如 `{reason}`。

## Prompt Registry

```toml
[prompts]
enabled = true
catalogPath = "resources/prompts.zh-CN.yaml"
defaultPurpose = "reasoning.chat_reply"
```

Prompt Bundle 是包含 `prompts`、`recipes` 和 `skills` 的 YAML 或 JSON 文件。Prompt 条目声明稳定片段，Recipe 按模型调用用途和场景维度选择片段，Skill 声明激活条件、提示词引用和工具依赖。模板中引用的 `{{ variable }}` 必须显式声明。

启用 Prompt Bundle 时必须同时设置 `catalogPath` 和 `defaultPurpose`。`agent.systemPrompt` 与 `prompts.defaultPromptId` 已移除，模型稳定指令只能通过 `Prompt Bundle → Invocation Envelope` 进入 Provider，避免存在两套隐式优先级。时间、当前输入、历史和检索结果属于结构化 Context，不得进入稳定 Prompt 片段。

## Presentation

```toml
[presentation]
mode = "deterministic"
# profilePath = "resources/presentation-profiles.yaml"
# defaultProfileId = "default"
```

Presentation 用于最终表达而非推理。`deterministic` 是当前可用模式，会在 Agent 产生规范结果后，以确定性方式处理长度、段落、Markdown 和代码块；Profile 只能收紧频道本身的输出边界。`model` 预留给将来的独立表达模型调用，当前启用会在配置校验阶段被拒绝。人格或表达 profile 不应放入 reasoning Prompt，避免其影响事实判断、规划和工具选择。

配置 `profilePath` 时必须同时配置 `defaultProfileId`。Profile Catalog 是包含 `profiles` 数组的 YAML 或 JSON 文件，可使用 `maxChars`、`maxParagraphs`、`allowMarkdown` 和 `allowCodeBlock`；Schema 会拒绝行为、权限、工具指令等未知字段。可参考 `examples/resources/presentation-profiles.yaml`。

## 资源路径

`locale.catalogPath`、`prompts.catalogPath` 和 `presentation.profilePath` 支持 YAML 或 JSON。相对路径以配置文件所在目录为基准，`~` 会展开到当前用户目录；因此示例配置中的 `resources/...` 对应 `examples/resources/...`。建议将内容资源与运行参数分开维护，并将同一配置引用的资源文件一起发布。

## Memory

```toml
[memory]
enableDurableMemory = false
```

Durable Memory 尚未实现，当前仅接受默认值 `false`。显式配置为 `true` 会在加载配置时失败；不要把该开关当作可用的存储、召回或 `/memory` 命令能力。

## Agent

```toml
[agent]
default = "qwen"

[agent.providers.qwen]
type = "openai-compatible"
apiKey = "${QWEN_API_KEY}"
baseUrl = "${QWEN_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
model = "qwen-plus"
temperature = 0.3
```

支持的 provider 类型：

- `echo`
- `openai-compatible`

OpenAI-compatible provider 必须显式配置 `baseUrl` 和 `model`；provider id 只用于本地引用，不决定厂商。

## Conversation

```toml
[conversation.privateTrigger]
mode = "always"

[conversation.groupTrigger]
mode = "mention"

[conversation.contextPolicy]
includeHistory = true
maxMessages = 20
```

触发模式：

- `always`
- `mention`
- `keyword`
- `mention_or_keyword`
- `never`

## Permissions

```toml
[permissions]
"channel.qq.send_group_message" = "allow"
"channel.qq.send_channel_message" = "allow"
"channel.qq.send_private_message" = "allow"
"channel.qq.manage_group" = "allow"
"channel.qq.send_media" = "deny"
```

权限策略：

- `allow`
- `deny`

`confirm`、`sandbox` 和 `rate_limit` 尚未具备可恢复工作流，因此当前公开配置会拒绝这些值，而不是把它们静默当作 `deny`。
