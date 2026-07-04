# Provider Runtime Comparison

本文对比 Synapse Runtime 当前的 provider/config 方案与常见 LLM 开发方案，便于判断项目边界和后续扩展方向。

## 定位差异

| 方案            | 核心定位                          | 适合场景                                                 | 不优先解决                            |
| --------------- | --------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| Synapse Runtime | 面向 Channel 的常驻 Agent Runtime | QQ/IM/webhook 等事件接入、权限控制、运行时配置、部署运维 | 通用 LLM 应用编排生态                 |
| OpenAI SDK      | 官方 API 客户端                   | 直接调用 OpenAI API、低层请求控制                        | 多厂商统一、channel runtime、权限策略 |
| LangChain       | LLM 应用编排框架                  | chain、agent、retriever、tool calling、复杂工作流        | 长驻 channel 服务和平台事件治理       |
| Vercel AI SDK   | Web/前端流式 AI SDK               | Next.js/React 服务端函数、流式 UI、chat UI               | IM channel 适配、权限和部署 runtime   |
| LlamaIndex      | 数据/RAG 框架                     | 文档索引、检索增强、知识库问答                           | channel 生命周期和消息发送策略        |

## Synapse Provider 方案

Synapse Runtime 现在使用 TOML 作为默认配置格式，provider 配置采用 OpenAI-compatible chat completions 作为主要抽象：

```toml
[agent]
default = "openai"

[agent.providers.openai]
type = "openai-compatible"
apiKey = "${OPENAI_API_KEY}"
baseUrl = "https://api.openai.com/v1"
model = "gpt-4.1-mini"
temperature = 0.3
topP = 0.8

[agent.providers.deepseek]
type = "openai-compatible"
apiKey = "${DEEPSEEK_API_KEY}"
baseUrl = "https://api.deepseek.com"
model = "deepseek-chat"
```

已内置的 `base` preset：

| base          | 默认 baseUrl                                              | 默认 model                 |
| ------------- | --------------------------------------------------------- | -------------------------- |
| `openai`      | `https://api.openai.com/v1`                               | `gpt-4.1-mini`             |
| `qwen`        | `https://dashscope.aliyuncs.com/compatible-mode/v1`       | `qwen-plus`                |
| `deepseek`    | `https://api.deepseek.com`                                | `deepseek-chat`            |
| `moonshot`    | `https://api.moonshot.cn/v1`                              | `moonshot-v1-8k`           |
| `zhipu`       | `https://open.bigmodel.cn/api/paas/v4`                    | `glm-4-flash`              |
| `mistral`     | `https://api.mistral.ai/v1`                               | `mistral-small-latest`     |
| `gemini`      | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash`         |
| `groq`        | `https://api.groq.com/openai/v1`                          | `llama-3.1-8b-instant`     |
| `xai`         | `https://api.x.ai/v1`                                     | `grok-2-latest`            |
| `openrouter`  | `https://openrouter.ai/api/v1`                            | `openai/gpt-4o-mini`       |
| `siliconflow` | `https://api.siliconflow.cn/v1`                           | `Qwen/Qwen2.5-7B-Instruct` |

`model` 不做枚举校验。新增模型时只改配置，不需要改 schema。推荐显式配置 `baseUrl` 和 `model`，`base` 只作为内置厂商的可选快捷预设。私有网关或未内置厂商可以直接声明自己的 `baseUrl`：

```toml
[agent.providers.private-gateway]
type = "openai-compatible"
baseUrl = "https://llm-gateway.internal/v1"
apiKey = "${LLM_GATEWAY_API_KEY}"
model = "company-chat-prod"
```

## 与 OpenAI SDK

OpenAI SDK 是更低层的 API 客户端，适合应用代码直接控制请求、响应、stream、tool calling 和文件等 OpenAI 专属能力。

Synapse Runtime 的 provider 层更适合：

- 把模型调用挂到 Channel 事件流中。
- 通过 TOML 在部署时切换厂商、模型和网关。
- 用统一权限与日志处理消息发送。
- 让 channel、conversation、agent 的组合保持稳定。

如果需要 OpenAI 专属的新 API 能力，应在 provider 内部扩展，而不是把业务代码直接绑定到 OpenAI SDK。

## 与 LangChain

LangChain 更像应用编排和工具生态层，关注 chain、agent、retriever、memory、tool abstraction。

Synapse Runtime 关注运行时边界：

- channel 适配和事件归一化。
- conversation 触发策略。
- provider 配置和密钥脱敏。
- 权限策略与消息发送审计。
- 常驻服务与控制台管理。

两者可以组合：LangChain 可以作为某个 `Agent` 的内部实现，Synapse 负责外部 channel 生命周期和部署配置。

## 与 Vercel AI SDK

Vercel AI SDK 优先服务 Web UI 和流式响应。它适合在 Next.js/React 中快速构建 chat 页面。

Synapse Runtime 不以 Web chat UI 为第一目标。它更重视：

- webhook/websocket channel 接入。
- 非浏览器会话的上下文策略。
- 服务端常驻进程。
- 跨 channel 的权限与配置治理。

如果未来需要 Web 控制台或 chat playground，可以在 Admin UI 使用 Vercel AI SDK，但不应替代 runtime provider 抽象。

## 与 LlamaIndex

LlamaIndex 更适合 RAG：数据加载、索引、检索、query engine。

Synapse Runtime 可以把 LlamaIndex 封装为 Agent 或 Tool：

- Synapse 接收 QQ/IM 消息。
- Agent 调用 LlamaIndex 查询知识库。
- Runtime 根据权限发送回复。

这样 RAG 能力和 channel/runtime 生命周期保持分离。

## 设计取舍

当前 provider 设计选择 OpenAI-compatible 作为最小公共接口，原因是多数主流厂商和网关都支持 `/chat/completions` 风格接口。代价是不同厂商的专属能力不会在第一层暴露。

扩展优先级：

1. 默认走 `openai-compatible`，优先用显式 `baseUrl` 和 `model` 配置切换。
2. 专属请求字段放到 `extraBody`。
3. 专属 header 放到 `headers`。
4. 只有当协议不兼容或能力无法表达时，新增独立 provider 类型。

这个边界能减少 schema 频繁变更，也避免配置序列化时被严格结构锁死。
