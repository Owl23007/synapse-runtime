# 配置

Runtime 配置由 `apps/runtime/src/config` 组合加载，文件解析、dotenv 与来源合并统一由 `@synapse/runtime-config` 提供。Loader 支持 TOML、YAML 和 JSON；仓库内的部署示例是 `examples/runtime.config.toml`。

显式配置文件是 Runtime 配置的主载体：模块结构、功能开关、资源路径和非敏感参数应写入配置文件并接受版本管理。env 不承载另一套完整配置，只用于给 `${VAR}` 占位符注入凭据、定位额外配置文件，以及通过 `SYNAPSE__<module>__<field>` 做进程级临时覆盖

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

错误逻辑使用稳定的错误码和 message key，展示边界再根据 `locale.default` 渲染用户可见文本。内置提供 `zh-CN` 和 `en` 默认消息，分别位于 `packages/runtime-resources/src/locales/zh-CN.json` 与 `packages/runtime-resources/src/locales/en.json`；`en-US` 等英文语言标签会复用 `en`。自定义 catalog 可覆盖或补充 message key。模板变量使用单花括号，例如 `{reason}`。

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

Durable Memory 默认关闭。启用后，`/memory remember`、`/memory list`、`/memory search` 和 `/memory delete` 使用 SQLite 持久化，并按身份与工作区隔离记忆；密钥记忆和已删除记忆不会进入模型上下文。以“记住”或“请记住”开头的消息会自动晋升为事实记忆。

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

## 来源覆盖与循环设置

配置分为框架态、部署态、工作区态、用户态和进程态。框架态保存内置默认值与不可绕过的 schema 约束；部署态是 `--config` 指向的主文件；工作区态和用户态只保存各自选择的覆盖值；会话、日志和数据库属于运行数据，不参与配置合并

支持 `--workspace-config <path>` 和 `--user-config <path>`。未显式指定用户配置时，CLI 会在存在 `~/.synapse/config.toml` 时自动加载；也可通过 `SYNAPSE_USER_CONFIG` 指定其他路径。覆盖顺序为模块默认值、框架配置、部署文件、workspace 文件、user 文件、环境变量、CLI；服务重载保留同一组来源选项

环境变量通过双下划线定位模块字段，例如 `SYNAPSE__agentLoop__maxSteps=12`。这类值高于文件来源，适合容器注入和临时覆盖，不应代替主配置文件。嵌套对象合并，数组替换，权限表按整表替换

```toml
[agentLoop]
maxSteps = 8
maxToolCalls = 16
```

配置文件中的资源路径始终相对于各自来源文件所在目录，临时配置覆盖不会自动写回文件
