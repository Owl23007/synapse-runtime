import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { parseConfigContent, parseConfigObject } from "./loader.js";
import { redactConfig } from "./redact.js";

describe("runtime config", () => {
  it("loads toml, expands env placeholders and applies defaults", () => {
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
    expect(config.channels["qq-local"]).toMatchObject({
      adapter: "onebot11",
      provider: "napcat",
      transport: "websocket",
      accessToken: "secret-token",
      enabled: true,
      riskLevel: "high"
    });
    expect(config.permissions["channel.qq.manage_group"]).toBe("deny");
  });

  it("supports openai-compatible provider bases in toml configs", () => {
    const config = parseConfigContent(
      `
[agent]
default = "openai"

[agent.providers.openai]
type = "openai-compatible"
base = "openai"
apiKey = "$\{OPENAI_API_KEY}"
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
      base: "openai",
      apiKey: "openai-key",
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

  it("supports json configs", () => {
    const config = parseConfigContent(
      JSON.stringify({
        runtime: { logLevel: "debug" },
        agent: {
          default: "qwen",
          providers: {
            qwen: {
              type: "qwen",
              apiKey: "qwen-key"
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
    expect(config.agent.providers.qwen).toMatchObject({
      type: "qwen",
      apiKey: "qwen-key",
      model: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    });
    expect(config.channels["qq-official"]).toMatchObject({
      adapter: "qq-official",
      mode: "webhook",
      enabled: false,
      riskLevel: "low"
    });
  });

  it("fails when a required env placeholder is missing", () => {
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

  it("rejects a default agent provider that is not defined", () => {
    expect(() =>
      parseConfigObject({
        agent: {
          default: "missing",
          providers: {
            qwen: {
              type: "qwen",
              apiKey: "qwen-key"
            }
          }
        }
      })
    ).toThrow(/Default agent provider "missing" is not defined/);
  });

  it("rejects enabled onebot channels in hosted mode", () => {
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

  it("redacts secret fields without mutating the source", () => {
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
