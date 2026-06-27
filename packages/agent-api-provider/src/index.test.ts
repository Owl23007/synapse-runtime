import { describe, expect, it } from "vitest";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { textMessage } from "@synapse/runtime-protocol";
import { ApiChatAgent, createQwenChatProvider, QWEN_COMPATIBLE_BASE_URL } from "./index.js";

describe("createQwenChatProvider", () => {
  it("calls the Qwen OpenAI-compatible chat completions endpoint", async () => {
    const requests: Array<{ url: string; headers?: Readonly<Record<string, string>>; body?: string }> = [];
    const provider = createQwenChatProvider({
      id: "qwen",
      apiKey: "api-key",
      model: "qwen-plus",
      temperature: 0.2,
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

    await expect(
      provider.complete({
        messages: [{ role: "user", content: "ping" }]
      })
    ).resolves.toMatchObject({ content: "pong" });

    expect(requests).toEqual([
      {
        url: `${QWEN_COMPATIBLE_BASE_URL}/chat/completions`,
        headers: {
          authorization: "Bearer api-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen-plus",
          messages: [{ role: "user", content: "ping" }],
          temperature: 0.2
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
