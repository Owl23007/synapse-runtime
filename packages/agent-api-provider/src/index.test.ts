import { describe, expect, it } from "vitest";
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
});

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
