import { describe, expect, it } from "vitest";
import type { AgentRuntimeContext } from "@synapse/runtime-agent-core";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { textMessage } from "@synapse/runtime-protocol";
import { ApiChatAgent, OpenAiCompatibleChatProvider } from "./index.js";

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

describe("ApiChatAgent", () => {
  it("turns agent requests into chat completions and returns a text output", async () => {
    const agent = new ApiChatAgent({
      id: "qwen-agent",
      systemPrompt: "You are concise.",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([
            { role: "system", content: "You are concise." },
            { role: "user", content: "hello" }
          ]);

          return { content: "hi" };
        }
      }
    });

    await expect(agent.run(agentRequest("hello"))).resolves.toMatchObject({
      id: "run-event-1",
      agentId: "qwen-agent",
      sessionId: "qq:user-1",
      status: "succeeded",
      output: textMessage("hi")
    });
  });

  it("forwards prompt context before the current user input", async () => {
    const agent = new ApiChatAgent({
      id: "qwen-agent",
      systemPrompt: "You are concise.",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([
            { role: "system", content: "You are concise." },
            { role: "system", content: "Use recent session history." },
            { role: "user", content: "previous question" },
            { role: "assistant", content: "previous answer" },
            { role: "user", content: "current question" }
          ]);

          return { content: "current answer" };
        }
      }
    });

    await expect(
      agent.run({
        ...agentRequest("current question"),
        promptContext: {
          system: "Use recent session history.",
          messages: [
            { role: "user", content: "previous question" },
            { role: "assistant", content: "previous answer" }
          ],
          metadata: {
            actorId: "guest:qq:napcat:qq-local:user-1",
            workspaceId: "personal:guest:qq:napcat:qq-local:user-1",
            sessionId: "qq:napcat:qq-local:private:user-1"
          }
        }
      })
    ).resolves.toMatchObject({
      status: "succeeded",
      output: textMessage("current answer")
    });
  });

  it("runs model tool model as one agent run", async () => {
    const modelRequests: unknown[] = [];
    const toolCalls: unknown[] = [];
    const agent = new ApiChatAgent({
      id: "tool-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          modelRequests.push(structuredClone(request));
          if (modelRequests.length === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-search",
                  name: "search_repository",
                  arguments: { query: "ContextAttributor" },
                  rawArguments: '{"query":"ContextAttributor"}'
                }
              ]
            };
          }
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "call-search",
            name: "search_repository"
          });
          expect(request.messages.at(-1)?.content).toContain("attribution.ts");
          return {
            content: "ContextAttributor 位于 attribution.ts",
            finishReason: "stop"
          };
        }
      }
    });

    const run = await agent.run(
      agentRequest("搜索 ContextAttributor"),
      agentContext(async (name, input, context) => {
        toolCalls.push({ name, input, context });
        return {
          status: "succeeded",
          output: { files: ["packages/runtime-core/src/context/attribution.ts"] }
        };
      })
    );

    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]).toMatchObject({
      tools: [
        {
          name: "search_repository",
          parameters: {
            required: ["query"],
            additionalProperties: false
          }
        }
      ]
    });
    expect(toolCalls).toEqual([
      {
        name: "search_repository",
        input: { query: "ContextAttributor" },
        context: { runId: "run-event-1", callId: "call-search" }
      }
    ]);
    expect(run).toMatchObject({
      status: "succeeded",
      output: textMessage("ContextAttributor 位于 attribution.ts"),
      steps: [
        { id: "model-1", kind: "model", status: "succeeded" },
        { id: "tool-1", kind: "tool", status: "succeeded" },
        { id: "model-2", kind: "model", status: "succeeded" }
      ]
    });
  });

  it("returns tool failures to the model as observations", async () => {
    let modelStep = 0;
    const agent = new ApiChatAgent({
      id: "recovering-tool-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          modelStep += 1;
          if (modelStep === 1) {
            return {
              content: "",
              toolCalls: [
                {
                  id: "call-failing",
                  name: "search_repository",
                  arguments: { query: "missing" },
                  rawArguments: '{"query":"missing"}'
                }
              ]
            };
          }
          expect(request.messages.at(-1)?.content).toContain("repository unavailable");
          return { content: "仓库暂时不可用，请稍后重试" };
        }
      }
    });

    const run = await agent.run(
      agentRequest("搜索仓库"),
      agentContext(async () => {
        throw new Error("repository unavailable");
      })
    );

    expect(run).toMatchObject({
      status: "succeeded",
      output: textMessage("仓库暂时不可用，请稍后重试"),
      steps: [
        { kind: "model", status: "succeeded" },
        { kind: "tool", status: "failed" },
        { kind: "model", status: "succeeded" }
      ]
    });
  });

  it("fails safely when the model step budget is exhausted", async () => {
    const agent = new ApiChatAgent({
      id: "budgeted-agent",
      maxSteps: 1,
      provider: {
        id: "test-provider",
        async complete() {
          return {
            content: "",
            toolCalls: [
              {
                id: "call-loop",
                name: "search_repository",
                arguments: { query: "loop" },
                rawArguments: '{"query":"loop"}'
              }
            ]
          };
        }
      }
    });

    await expect(
      agent.run(
        agentRequest("不断搜索"),
        agentContext(async () => ({
          status: "succeeded",
          output: { files: [] }
        }))
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: "Agent loop exceeded the model step limit of 1.",
      steps: [
        { kind: "model", status: "succeeded" },
        { kind: "tool", status: "succeeded" }
      ]
    });
  });
});

function agentContext(
  call: (
    name: string,
    input: unknown,
    context: { readonly runId: string; readonly callId?: string }
  ) => Promise<
    | { readonly status: "succeeded"; readonly output?: unknown }
    | { readonly status: "blocked"; readonly reason?: string }
  >
): AgentRuntimeContext {
  return {
    tools: {
      list: () => [
        {
          name: "search_repository",
          description: "搜索仓库",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" }
            },
            required: ["query"],
            additionalProperties: false
          },
          permission: {
            action: "repository.search",
            resource: "workspace"
          },
          async handle() {
            return undefined;
          }
        }
      ],
      async decidePermission(request) {
        return {
          action: request.action,
          resource: request.resource,
          decision: "allow"
        };
      },
      call: async <TOutput = unknown>(
        name: string,
        input: unknown,
        context: { readonly runId: string; readonly callId?: string }
      ) => {
        const result = await call(name, input, context);
        return result.status === "blocked"
          ? result
          : {
              status: "succeeded",
              output: result.output as TOutput
            };
      }
    },
    conversation: {
      async createBranch(input) {
        return {
          id: `branch-${input.idempotencyKey}`,
          sessionId: "qq:user-1",
          parentMainlineId: "mainline:qq:user-1",
          sourceEventId: "event-1",
          status: "created"
        };
      }
    }
  };
}

function agentRequest(text: string): AgentRequest {
  return {
    sessionId: "qq:user-1",
    userId: "user-1",
    input: textMessage(text),
    source: {
      platform: "qq",
      channelId: "qq-official",
      conversationId: "user-1",
      conversationKind: "private"
    },
    contextPolicy: { includeHistory: true, maxMessages: 20 },
    event: {
      id: "event-1",
      platform: "qq",
      channelId: "qq-official",
      eventType: "message.created",
      conversation: { id: "user-1", kind: "private" },
      sender: { id: "user-1" },
      message: textMessage(text),
      raw: {},
      receivedAt: new Date(0).toISOString()
    }
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}
