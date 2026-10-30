import { describe, expect, it } from "vitest";
import type { AgentRuntimeContext } from "@synapse/runtime-agent-core";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { textMessage } from "@synapse/runtime-protocol";
import { ApiChatAgent } from "../../src/index.js";

describe("API 聊天代理", () => {
  it("拒绝绕过调用编译器的请求", async () => {
    const agent = new ApiChatAgent({
      id: "strict-agent",
      provider: {
        id: "unused",
        async complete() {
          return { content: "unused" };
        }
      }
    });
    const { invocation: _invocation, ...request } = agentRequest("hello");

    await expect(agent.run(request)).rejects.toThrow(/requires a compiled Model Invocation Envelope/);
  });

  it("将代理请求转换为聊天补全并返回文本输出", async () => {
    const agent = new ApiChatAgent({
      id: "qwen-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([{ role: "user", content: "hello" }]);

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

  it("序列化调用信封且仅暴露已编译工具", async () => {
    const agent = new ApiChatAgent({
      id: "compiled-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([
            { role: "system", content: "Runtime rules." },
            { role: "user", content: "review" }
          ]);
          expect(request.tools?.map((tool) => tool.name)).toEqual(["repository.diff"]);
          return { content: "done" };
        }
      }
    });
    const request = agentRequest("review");

    await expect(
      agent.run(
        {
          ...request,
          invocation: {
            prompt: {
              recipeId: "reasoning.chat",
              recipeVersion: "1",
              scene: { purpose: "reasoning.chat_reply", dimensions: { conversationKind: "private" } },
              blocks: [
                {
                  promptId: "runtime.core",
                  version: "1",
                  stage: "reasoning",
                  slot: "runtime",
                  content: "Runtime rules.",
                  stable: true,
                  cacheScope: "global"
                }
              ],
              digest: "prompt-v1"
            },
            capabilities: {
              toolIds: ["repository.diff"],
              toolSetDigest: "tools-v1",
              activeSkills: [],
              skillSetDigest: "skills-empty"
            }
          }
        },
        agentContextWithTools(["filesystem.write", "repository.diff"])
      )
    ).resolves.toMatchObject({ status: "succeeded", output: textMessage("done") });
  });

  it("在当前用户输入前转发提示词上下文", async () => {
    const agent = new ApiChatAgent({
      id: "qwen-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([
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
          messages: [
            { role: "user", content: "previous question" },
            { role: "assistant", content: "previous answer" }
          ],
          metadata: {
            actorId: "guest:qq:napcat:qq-local:user-1",
            workspaceId: "personal:guest:qq:napcat:qq-local:user-1",
            sessionId: "qq:napcat:qq-local:private:user-1"
          },
          sections: [
            {
              id: "session",
              blocks: [
                {
                  id: "session-guidance",
                  content: "Use recent session history.",
                  source: "runtime",
                  stability: "session",
                  required: true,
                  priority: 1
                }
              ]
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      status: "succeeded",
      output: textMessage("current answer")
    });
  });

  it("将结构化上下文渲染为确定且稳定的前缀", async () => {
    const agent = new ApiChatAgent({
      id: "structured-context-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.messages).toEqual([
            { role: "system", content: "Global high priority." },
            { role: "system", content: "Global low priority." },
            { role: "system", content: "Workspace context." },
            { role: "system", content: "Current retrieval." },
            { role: "user", content: "previous question" },
            { role: "user", content: "current question" }
          ]);
          expect(request).not.toHaveProperty("extraBody");
          return { content: "answer" };
        }
      }
    });

    await expect(
      agent.run({
        ...agentRequest("current question"),
        promptContext: {
          messages: [{ role: "user", content: "previous question" }],
          metadata: {},
          sections: [
            {
              id: "dynamic",
              blocks: [
                {
                  id: "retrieval",
                  content: "Current retrieval.",
                  source: "retrieval",
                  stability: "turn",
                  required: false,
                  priority: 100,
                  cache: { scope: "none", metadata: { reason: "per-request" } }
                }
              ]
            },
            {
              id: "stable",
              blocks: [
                {
                  id: "workspace",
                  content: "Workspace context.",
                  source: "workspace",
                  stability: "workspace",
                  required: true,
                  priority: 10,
                  cache: { scope: "workspace" }
                },
                {
                  id: "low",
                  content: "Global low priority.",
                  source: "runtime",
                  stability: "global",
                  required: true,
                  priority: 10,
                  cache: { scope: "global" }
                },
                {
                  id: "high",
                  content: "Global high priority.",
                  source: "runtime",
                  stability: "global",
                  required: true,
                  priority: 20,
                  cache: { scope: "global" }
                }
              ]
            }
          ]
        }
      })
    ).resolves.toMatchObject({ status: "succeeded", output: textMessage("answer") });
  });

  it("按稳定名称排序工具定义", async () => {
    const agent = new ApiChatAgent({
      id: "sorted-tools-agent",
      provider: {
        id: "test-provider",
        async complete(request) {
          expect(request.tools?.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
          return { content: "answer" };
        }
      }
    });

    await expect(agent.run(agentRequest("hello"), agentContextWithTools(["zeta", "alpha"]))).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("将模型、工具与模型调用作为一次代理运行", async () => {
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

  it("将工具失败作为观测结果返回给模型", async () => {
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

  it("模型步数预算耗尽时安全失败", async () => {
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

function agentContextWithTools(names: readonly string[]): AgentRuntimeContext {
  const base = agentContext(async () => ({ status: "succeeded", output: undefined }));
  const template = base.tools.list()[0];
  if (template === undefined) {
    throw new Error("Expected a tool template");
  }
  return {
    ...base,
    tools: {
      ...base.tools,
      list: () => names.map((name) => ({ ...template, name }))
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
    invocation: {
      prompt: {
        recipeId: "test.reasoning",
        recipeVersion: "1",
        scene: { purpose: "reasoning.chat_reply", dimensions: {} },
        blocks: [],
        digest: "test-prompt"
      },
      capabilities: {
        toolIds: ["alpha", "search_repository", "zeta"],
        toolSetDigest: "test-tools",
        activeSkills: [],
        skillSetDigest: "test-skills"
      }
    },
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
