import { expect, it } from "vitest";
import type { AgentRequest } from "@synapse/runtime-conversation";
import type { AgentModelEvent, AgentRuntimeContext } from "@synapse/runtime-agent-core";
import { textMessage } from "@synapse/runtime-protocol";
import { ApiChatAgent } from "../../src/index.js";

function request(): AgentRequest {
  return {
    sessionId: "native",
    userId: "admin",
    input: textMessage("hello"),
    source: { platform: "native", channelId: "native", conversationId: "native", conversationKind: "private" },
    contextPolicy: { includeHistory: true, maxMessages: 20 },
    invocation: {
      prompt: {
        recipeId: "test",
        recipeVersion: "1",
        scene: { purpose: "reasoning.chat_reply", dimensions: {} },
        blocks: [],
        digest: "test"
      },
      capabilities: { toolIds: [], toolSetDigest: "empty", activeSkills: [], skillSetDigest: "empty" }
    },
    event: {
      id: "event",
      platform: "native",
      channelId: "native",
      eventType: "message.created",
      conversation: { id: "native", kind: "private" },
      sender: { id: "admin" },
      message: textMessage("hello"),
      raw: {},
      receivedAt: "2026-01-01T00:00:00Z"
    }
  };
}
function context(observeModel: (event: AgentModelEvent) => void, streamText = true): AgentRuntimeContext {
  return {
    streamText,
    observeModel,
    tools: {
      list: () => [],
      call: async () => ({ status: "blocked", reason: "unused" }),
      decidePermission: async (input) => ({ action: input.action, resource: input.resource, decision: "allow" })
    },
    conversation: {
      createBranch: async () => {
        throw new Error("unused");
      }
    }
  };
}

it.each([true, false])("仅在宿主启用时发布有界正文快照，最终输出保持完整：%s", async (streamText) => {
  const events: AgentModelEvent[] = [];
  const text = "回复".repeat(7000);
  const agent = new ApiChatAgent({
    id: "test",
    provider: {
      id: "test",
      async complete(input) {
        expect(typeof input.onTextDelta).toBe(streamText ? "function" : "undefined");
        await input.onTextDelta?.("第一段");
        await input.onTextDelta?.(text);
        return { content: `第一段${text}` };
      }
    }
  });
  const result = await agent.run(
    request(),
    context((event) => {
      events.push(event);
    }, streamText)
  );
  expect(result.output).toEqual(textMessage(`第一段${text}`));
  const snapshots = events.filter((event) => event.type === "model_output");
  expect(snapshots.length > 0).toBe(streamText);
  expect((snapshots.at(-1)?.data as { content: string } | undefined)?.content.length).toBe(
    streamText ? 12_000 : undefined
  );
  expect(events.at(-1)?.type).toBe("model_call_succeeded");
});

it("正文观察写入失败时停止 Provider 后续处理", async () => {
  let continued = false;
  const agent = new ApiChatAgent({
    id: "test",
    provider: {
      id: "test",
      async complete(input) {
        await input.onTextDelta?.("生成中");
        continued = true;
        return { content: "不应继续" };
      }
    }
  });
  const result = await agent.run(
    request(),
    context((event) => {
      if (event.type === "model_output") throw new Error("正文持久化失败");
    })
  );
  expect(continued).toBe(false);
  expect(result).toMatchObject({ status: "failed", error: "正文持久化失败" });
});
