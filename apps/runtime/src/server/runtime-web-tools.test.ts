import type { AgentRuntimeContext } from "@synapse/runtime-agent-core";
import { ApiChatAgent } from "@synapse/runtime-agent-api-provider";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage } from "@synapse/runtime-protocol";
import { createWebTools, type WebFetch } from "@synapse/runtime-tool-web";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { describe, expect, it, vi } from "vitest";

describe("production web tool loop", () => {
  it("completes search fetch and answer in one agent run", async () => {
    const webFetch = vi.fn<WebFetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.search.brave.com") {
        return Response.json({
          web: {
            results: [
              {
                title: "Synapse Runtime docs",
                url: "https://docs.example.com/synapse",
                description: "Runtime documentation"
              }
            ]
          }
        });
      }
      return new Response(
        "<html><head><title>Synapse Runtime</title></head><body><p>Durable agent runtime</p></body></html>",
        {
          headers: { "content-type": "text/html" }
        }
      );
    });
    const tools = new ToolRuntime(
      new StaticPermissionEngine({
        "network.web.search": "allow",
        "network.web.fetch": "allow"
      })
    );
    for (const tool of createWebTools({
      search: { provider: "brave", apiKey: "brave-key" },
      fetch: webFetch,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }]
    })) {
      tools.register(tool);
    }
    let modelStep = 0;
    const agent = new ApiChatAgent({
      id: "web-agent",
      provider: {
        id: "fake-model",
        async complete(request) {
          modelStep += 1;
          if (modelStep === 1) {
            expect(request.tools?.map((tool) => tool.name)).toEqual(["web.fetch", "web.search"]);
            return {
              content: "",
              toolCalls: [
                {
                  id: "search-1",
                  name: "web.search",
                  arguments: { query: "Synapse Runtime", count: 3 },
                  rawArguments: '{"query":"Synapse Runtime","count":3}'
                }
              ]
            };
          }
          if (modelStep === 2) {
            expect(request.messages.at(-1)?.content).toContain("https://docs.example.com/synapse");
            return {
              content: "",
              toolCalls: [
                {
                  id: "fetch-1",
                  name: "web.fetch",
                  arguments: { url: "https://docs.example.com/synapse" },
                  rawArguments: '{"url":"https://docs.example.com/synapse"}'
                }
              ]
            };
          }
          expect(request.messages.at(-1)?.content).toContain("Durable agent runtime");
          return {
            content: "Synapse Runtime 是持久化 Agent Runtime\n来源：https://docs.example.com/synapse"
          };
        }
      }
    });

    const run = await agent.run(agentRequest("联网查询 Synapse Runtime"), agentContext(tools));

    expect(run).toMatchObject({
      status: "succeeded",
      output: textMessage("Synapse Runtime 是持久化 Agent Runtime\n来源：https://docs.example.com/synapse"),
      steps: [
        { kind: "model", status: "succeeded" },
        { kind: "tool", status: "succeeded", detail: "web.search" },
        { kind: "model", status: "succeeded" },
        { kind: "tool", status: "succeeded", detail: "web.fetch" },
        { kind: "model", status: "succeeded" }
      ]
    });
    expect(webFetch).toHaveBeenCalledTimes(2);
  });
});

function agentContext(tools: ToolRuntime): AgentRuntimeContext {
  return {
    tools: tools.withContext({
      sessionId: "qq:user-1",
      userId: "user-1"
    }),
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
    invocation: {
      prompt: {
        recipeId: "reasoning.web",
        recipeVersion: "1",
        scene: { purpose: "reasoning.chat_reply", dimensions: { toolMode: "enabled" } },
        blocks: [],
        digest: "test-prompt"
      },
      capabilities: {
        toolIds: ["web.fetch", "web.search"],
        toolSetDigest: "test-web-tools",
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
