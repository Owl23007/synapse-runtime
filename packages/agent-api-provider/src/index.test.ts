import { describe, expect, it } from "vitest";
import { OpenAiCompatibleChatProvider } from "./index.js";
describe("OpenAiCompatibleChatProvider", () => {
  it("uses explicit endpoints and forwards compatible request options", async () => {
    const requests: Array<{ url: string; headers?: Readonly<Record<string, string>>; body?: string }> = [];
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      apiKey: "api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      topP: 0.8,
      headers: {
        "x-provider": "test"
      },
      extraBody: {
        seed: 7
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body })
        });

        return jsonResponse({
          choices: [{ message: { content: "pong" } }]
        });
      }
    });

    await provider.complete({
      messages: [{ role: "user", content: "ping" }]
    });

    expect(requests).toEqual([
      {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "x-provider": "test",
          authorization: "Bearer api-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          seed: 7,
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "ping" }],
          top_p: 0.8
        })
      }
    ]);
  });

  it("uses explicit baseUrl and model for private gateways", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const provider = new OpenAiCompatibleChatProvider({
      id: "private-gateway",
      apiKey: "api-key",
      baseUrl: "https://llm-gateway.internal/v1",
      model: "company-chat-prod",
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.body === undefined ? {} : { body: init.body })
        });

        return jsonResponse({
          choices: [{ message: { content: "pong" } }]
        });
      }
    });

    await provider.complete({
      messages: [{ role: "user", content: "ping" }]
    });

    expect(requests).toEqual([
      {
        url: "https://llm-gateway.internal/v1/chat/completions",
        body: JSON.stringify({
          model: "company-chat-prod",
          messages: [{ role: "user", content: "ping" }]
        })
      }
    ]);
  });

  it("serializes tool definitions and parses structured tool calls", async () => {
    let requestBody: unknown;
    const provider = new OpenAiCompatibleChatProvider({
      id: "tool-provider",
      apiKey: "api-key",
      baseUrl: "https://llm.example/v1",
      model: "tool-model",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init?.body ?? "{}") as unknown;
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-time",
                    type: "function",
                    function: {
                      name: "get_current_time",
                      arguments: '{"timezone":"Asia/Shanghai"}'
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 20,
            prompt_tokens_details: {
              cached_tokens: 12
            },
            completion_tokens: 8,
            total_tokens: 28
          }
        });
      }
    });

    await expect(
      provider.complete({
        messages: [{ role: "user", content: "现在几点" }],
        tools: [
          {
            name: "get_current_time",
            description: "查询当前时间",
            parameters: {
              type: "object",
              additionalProperties: true
            }
          }
        ],
        toolChoice: "auto"
      })
    ).resolves.toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-time",
          name: "get_current_time",
          arguments: { timezone: "Asia/Shanghai" }
        }
      ],
      usage: {
        promptTokens: 20,
        cachedPromptTokens: 12,
        completionTokens: 8,
        totalTokens: 28
      }
    });
    expect(requestBody).toMatchObject({
      model: "tool-model",
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "get_current_time",
            description: "查询当前时间"
          }
        }
      ]
    });
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}
