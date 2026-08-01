import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeContext } from "@synapse/runtime-agent-core";
import { parseConfigObject } from "@synapse/runtime-config";
import type { AgentRequest } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { textMessage } from "@synapse/runtime-protocol";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { describe, expect, it } from "vitest";
import { createAgentFromConfig } from "./agent-factory.js";

describe("createAgentFromConfig Prompt Registry", () => {
  it("loads and renders the configured reasoning prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-prompt-registry-"));
    const catalogPath = join(directory, "prompts.zh-CN.yaml");
    writeFileSync(
      catalogPath,
      [
        "prompts:",
        "  - id: chat.reasoning",
        '    version: "1"',
        "    stage: reasoning",
        "    variables: [runtimeName, locale, contextStrategy]",
        "    template: '{{ runtimeName }}|{{ locale }}|{{ contextStrategy }}'"
      ].join("\n"),
      "utf8"
    );
    let requestBody: unknown;
    const config = parseConfigObject({
      runtime: { dataDir: directory },
      locale: { default: "zh-CN" },
      prompts: { enabled: true, catalogPath, defaultPromptId: "chat.reasoning" },
      context: { strategy: "private-chat" },
      agent: {
        default: "test",
        providers: {
          test: {
            type: "openai-compatible",
            apiKey: "test-key",
            baseUrl: "https://model.example.com/v1",
            model: "test-model"
          }
        }
      }
    });

    try {
      const agent = createAgentFromConfig(config, {
        fetch: async (_url, init) => {
          requestBody = JSON.parse(init?.body ?? "null") as unknown;
          return {
            ok: true,
            status: 200,
            async json() {
              return { choices: [{ message: { content: "完成" }, finish_reason: "stop" }] };
            }
          };
        }
      });
      const run = await agent.run(agentRequest(), agentContext());

      expect(run.status).toBe("succeeded");
      expect(requestBody).toMatchObject({
        messages: [
          { role: "system", content: "Synapse Runtime|zh-CN|private-chat" },
          { role: "user", content: "你好" }
        ]
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function agentRequest(): AgentRequest {
  return {
    sessionId: "qq:user-1",
    userId: "user-1",
    input: textMessage("你好"),
    source: {
      platform: "qq",
      channelId: "qq-official",
      conversationId: "user-1",
      conversationKind: "private"
    },
    contextPolicy: { includeHistory: false, maxMessages: 1 },
    event: {
      id: "event-1",
      platform: "qq",
      channelId: "qq-official",
      eventType: "message.created",
      conversation: { id: "user-1", kind: "private" },
      sender: { id: "user-1" },
      message: textMessage("你好"),
      receivedAt: "2026-08-01T12:00:00.000Z"
    }
  };
}

function agentContext(): AgentRuntimeContext {
  const tools = new ToolRuntime(new StaticPermissionEngine({}));
  return {
    tools: tools.withContext({ sessionId: "qq:user-1", userId: "user-1" }),
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
