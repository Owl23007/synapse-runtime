import { rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { ConfigError } from "@synapse/runtime-config";
import { loadConfigFile, parseConfigContent, parseConfigObject } from "../../../src/config/loader.js";
import { redactConfig } from "@synapse/runtime-config";
import { DEFAULT_RUNTIME_DATA_DIR } from "../../../src/config/schema.js";

describe("运行时配置", () => {
  it("默认将运行时数据目录设为用户目录", () => {
    const config = parseConfigContent("", "runtime.config.toml");

    expect(config.runtime.dataDir).toBe(DEFAULT_RUNTIME_DATA_DIR);
    expect(config.runtime.dataDir).toBe(join(homedir(), ".synapse", "runtime"));
  });

  it("展开相对于用户主目录的数据目录", () => {
    const config = parseConfigContent(
      `
[runtime]
dataDir = "~/.synapse/custom-runtime"
`,
      "runtime.config.toml"
    );

    expect(config.runtime.dataDir).toBe(join(homedir(), ".synapse", "custom-runtime"));
  });

  it("展开用户主目录前去除数据目录两端空白", () => {
    const config = parseConfigContent(
      `
[runtime]
dataDir = " ~/.synapse/custom-runtime "
`,
      "/home/ubuntu/apps/synapse-runtime/examples/runtime.config.toml"
    );

    expect(config.runtime.dataDir).toBe(join(homedir(), ".synapse", "custom-runtime"));
    expect(config.runtime.dataDir).not.toContain("/apps/synapse-runtime/~");
  });

  it("相对于配置文件目录解析数据目录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-config-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const configDir = join(dir, "config");
    const configPath = join(configDir, "runtime.config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      `
[runtime]
dataDir = ".synapse"
`,
      "utf8"
    );

    const config = await loadConfigFile(configPath);

    expect(config.runtime.dataDir).toBe(resolve(configDir, ".synapse"));
  });

  it("加载 TOML 并展开环境占位符且应用默认值", () => {
    const config = parseConfigContent(
      `
[channels."qq-local"]
adapter = "onebot11"
endpoint = "ws://127.0.0.1:3001"
accessToken = "$\{NAPCAT_TOKEN}"
`,
      "runtime.config.toml",
      { env: { NAPCAT_TOKEN: "secret-token" } }
    );

    expect(config.runtime.mode).toBe("local");
    expect(config.context).toMatchObject({
      enabled: true,
      maxHistoryChars: 6000
    });
    expect(config.memory).toMatchObject({
      enableDurableMemory: false
    });
    expect(config.channels["qq-local"]).toMatchObject({
      adapter: "onebot11",
      provider: "napcat",
      transport: "websocket",
      accessToken: "secret-token",
      enabled: true,
      riskLevel: "high"
    });
    expect(config.permissions["channel.qq.manage_group"]).toBe("deny");
    expect(config.permissions["channel.qq.send_private_message"]).toBe("deny");
  });

  it("拒绝尚未实现的通道传输与权限工作流", () => {
    expect(() =>
      parseConfigObject({
        channels: {
          local: { adapter: "onebot11", endpoint: "ws://127.0.0.1:3001", transport: "http" }
        }
      })
    ).toThrow();
    expect(() =>
      parseConfigObject({
        channels: {
          official: {
            adapter: "qq-official",
            appId: "app",
            appSecret: "secret",
            mode: "websocket"
          }
        }
      })
    ).toThrow();
    expect(() => parseConfigObject({ permissions: { "tool.write": "confirm" } })).toThrow();
  });

  it("支持 TOML 中显式配置 OpenAI 兼容提供者", () => {
    const config = parseConfigContent(
      `
[agent]
default = "openai"

[agent.providers.openai]
type = "openai-compatible"
apiKey = "$\{OPENAI_API_KEY}"
baseUrl = "https://api.openai.com/v1"
model = "gpt-4.1-mini"
topP = 0.8

[agent.providers.openai.headers]
"HTTP-Referer" = "https://example.com"

[agent.providers.openai.extraBody]
seed = 7
`,
      "runtime.config.toml",
      { env: { OPENAI_API_KEY: "openai-key" } }
    );

    expect(config.agent.providers.openai).toMatchObject({
      type: "openai-compatible",
      apiKey: "openai-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      topP: 0.8,
      headers: {
        "HTTP-Referer": "https://example.com"
      },
      extraBody: {
        seed: 7
      }
    });
  });

  it("支持私有 OpenAI 兼容网关", () => {
    const config = parseConfigContent(
      `
[agent]
default = "private-gateway"

[agent.providers.private-gateway]
type = "openai-compatible"
apiKey = "$\{LLM_GATEWAY_API_KEY}"
baseUrl = "https://llm-gateway.internal/v1"
model = "company-chat-prod"
`,
      "runtime.config.toml",
      { env: { LLM_GATEWAY_API_KEY: "gateway-key" } }
    );

    expect(config.agent.providers["private-gateway"]).toMatchObject({
      type: "openai-compatible",
      apiKey: "gateway-key",
      baseUrl: "https://llm-gateway.internal/v1",
      model: "company-chat-prod"
    });
  });

  it("支持 JSON 配置", () => {
    const config = parseConfigContent(
      JSON.stringify({
        runtime: { logLevel: "debug" },
        agent: {
          default: "qwen",
          providers: {
            qwen: {
              type: "openai-compatible",
              apiKey: "qwen-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              model: "qwen-plus"
            }
          }
        },
        channels: {
          "qq-official": {
            adapter: "qq-official",
            appId: "app-id",
            appSecret: "app-secret"
          }
        }
      }),
      "runtime.config.json"
    );

    expect(config.runtime.logLevel).toBe("debug");
    expect(config.admin).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 3766
    });
    expect(config.agent.providers.qwen).toMatchObject({
      type: "openai-compatible",
      apiKey: "qwen-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus"
    });
    expect(config.channels["qq-official"]).toMatchObject({
      adapter: "qq-official",
      mode: "webhook",
      enabled: false,
      riskLevel: "low"
    });
  });

  it("支持运行时上下文设置", () => {
    const config = parseConfigContent(
      `
[context]
enabled = false
maxHistoryChars = 1200
`,
      "runtime.config.toml"
    );

    expect(config.context).toMatchObject({
      enabled: false,
      maxHistoryChars: 1200,
      strategy: "default",
      cache: { enabled: true }
    });
  });

  it("默认使用中文语言并显式禁用提示词编译", () => {
    const config = parseConfigObject({});

    expect(config.locale).toEqual({ default: "zh-CN" });
    expect(config.prompts).toEqual({ enabled: false });
    expect(config.presentation).toEqual({ mode: "deterministic" });
    expect(config.agent).toEqual({ providers: {} });
  });

  it("相对于配置文件规范化外部资源路径", () => {
    const config = parseConfigContent(
      `
[locale]
catalogPath = "resources/locales.zh-CN.yaml"

[prompts]
enabled = true
catalogPath = "~/synapse/prompts.zh-CN.yaml"
defaultPurpose = "reasoning.chat_reply"

[presentation]
profilePath = "resources/presentation-profiles.yaml"
defaultProfileId = "default"
`,
      "/opt/synapse/config/runtime.config.toml"
    );

    expect(config.locale.catalogPath).toBe(resolve("/opt/synapse/config/resources/locales.zh-CN.yaml"));
    expect(config.prompts.catalogPath).toBe(join(homedir(), "synapse", "prompts.zh-CN.yaml"));
    expect(config.presentation.profilePath).toBe(resolve("/opt/synapse/config/resources/presentation-profiles.yaml"));
    expect(config.presentation.defaultProfileId).toBe("default");
  });

  it("要求同时提供展示配置标识与路径", () => {
    expect(() => parseConfigObject({ presentation: { profilePath: "profiles.yaml" } })).toThrow(
      /presentation\.defaultProfileId/
    );
    expect(() => parseConfigObject({ presentation: { defaultProfileId: "default" } })).toThrow(
      /presentation\.profilePath/
    );
  });

  it("要求完整提示词包并拒绝已移除的提示词字段", () => {
    expect(() => parseConfigObject({ prompts: { enabled: true } })).toThrow(/prompts\.catalogPath/);
    expect(() =>
      parseConfigObject({
        prompts: { enabled: true, catalogPath: "prompts.yaml", defaultPromptId: "chat.reasoning" }
      })
    ).toThrow(/prompts\.defaultPromptId/);
    expect(() => parseConfigObject({ agent: { systemPrompt: "legacy prompt" } })).toThrow(/agent\.systemPrompt/);
  });

  it("独立展示调用尚未实现时拒绝模型展示配置", () => {
    expect(() => parseConfigObject({ presentation: { mode: "model" } })).toThrow(
      /Model presentation is not implemented/
    );
  });

  it("接受显式启用的持久记忆", () => {
    const config = parseConfigContent(
      `
[memory]
enableDurableMemory = true
`,
      "runtime.config.toml"
    );
    expect(config.memory.enableDurableMemory).toBe(true);
  });

  it("支持受防护的网页工具与 Brave 搜索", () => {
    const config = parseConfigContent(
      `
[tools.web]
enabled = true
allowedDomains = ["docs.example.com"]
deniedDomains = ["private.example.com"]
timeoutMs = 8000
maxContentChars = 12000

[tools.web.search]
provider = "brave"
apiKey = "$\{BRAVE_SEARCH_API_KEY}"
`,
      "runtime.config.toml",
      { env: { BRAVE_SEARCH_API_KEY: "brave-key" } }
    );

    expect(config.tools.web).toMatchObject({
      enabled: true,
      allowedDomains: ["docs.example.com"],
      deniedDomains: ["private.example.com"],
      allowPrivateNetwork: false,
      timeoutMs: 8000,
      maxResponseBytes: 2_000_000,
      maxContentChars: 12000,
      maxRedirects: 5,
      search: {
        provider: "brave",
        apiKey: "brave-key",
        baseUrl: "https://api.search.brave.com/res/v1/web/search"
      }
    });
    expect(config.permissions["network.web.search"]).toBe("allow");
    expect(config.permissions["network.web.fetch"]).toBe("allow");
  });

  it("支持自托管 SearXNG 搜索", () => {
    const config = parseConfigObject({
      tools: {
        web: {
          enabled: true,
          search: {
            provider: "searxng",
            baseUrl: "https://search.example.com/search"
          }
        }
      }
    });

    expect(config.tools.web.search).toEqual({
      provider: "searxng",
      baseUrl: "https://search.example.com/search"
    });
  });

  it("必需的环境占位符缺失时失败", () => {
    expect(() =>
      parseConfigObject({
        channels: {
          "qq-local": {
            adapter: "onebot11",
            endpoint: "$\{NAPCAT_ENDPOINT}"
          }
        }
      })
    ).toThrow(ConfigError);
  });

  it("拒绝未定义的默认代理提供者", () => {
    expect(() =>
      parseConfigObject({
        agent: {
          default: "missing",
          providers: {
            qwen: {
              type: "openai-compatible",
              apiKey: "qwen-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              model: "qwen-plus"
            }
          }
        }
      })
    ).toThrow(/Default agent provider "missing" is not defined/);
  });

  it("要求 OpenAI 兼容提供者显式指定端点与模型", () => {
    expect(() =>
      parseConfigObject({
        agent: {
          default: "private-gateway",
          providers: {
            "private-gateway": {
              type: "openai-compatible",
              apiKey: "gateway-key"
            }
          }
        }
      })
    ).toThrow(/baseUrl: Required/);
  });

  it("拒绝旧版 qwen 提供者类型", () => {
    expect(() =>
      parseConfigObject({
        agent: {
          default: "qwen",
          providers: {
            qwen: {
              type: "qwen",
              apiKey: "qwen-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
              model: "qwen-plus"
            }
          }
        }
      })
    ).toThrow(/Invalid discriminator value/);
  });

  it("托管模式下拒绝启用 OneBot 通道", () => {
    expect(() =>
      parseConfigObject({
        runtime: { mode: "hosted" },
        channels: {
          "qq-local": {
            adapter: "onebot11",
            endpoint: "ws://127.0.0.1:3001"
          }
        }
      })
    ).toThrow(/Hosted mode cannot enable onebot11 channels/);
  });

  it("脱敏密钥字段且不修改源对象", () => {
    const config = parseConfigObject({
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret"
        }
      }
    });

    const redacted = redactConfig(config);

    expect(redacted.channels["qq-official"]).toMatchObject({
      adapter: "qq-official",
      appSecret: "[REDACTED]"
    });
    expect(config.channels["qq-official"]).toMatchObject({
      appSecret: "app-secret"
    });
  });
});
