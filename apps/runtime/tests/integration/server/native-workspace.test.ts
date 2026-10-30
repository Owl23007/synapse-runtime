import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "../../../src/config/index.js";
import { createRuntimeAssembly } from "../../../src/composition/runtime-assembly.js";

describe("原生模型与工具工作流", () => {
  it("没有外部频道也能执行容器工具、保存工件，历史分支不读取之后的主线消息", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-native-model-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const requests: string[] = [];
    let executions = 0;
    const assembly = createRuntimeAssembly({
      config: parseConfigObject({
        runtime: { dataDir: directory },
        container: { enabled: true },
        prompts: {
          enabled: true,
          catalogPath: resolve("../../examples/resources/prompts.zh-CN.yaml"),
          defaultPurpose: "reasoning.chat_reply"
        },
        agent: {
          default: "model",
          providers: {
            model: {
              type: "openai-compatible",
              apiKey: "native-model-test-key",
              baseUrl: "https://model.invalid/v1",
              model: "native-model"
            }
          }
        },
        permissions: { "container.execute": "allow" }
      }),
      channels: new InMemoryChannelRegistry(),
      logger: { info() {}, warn() {}, error() {} },
      containerRunner: async (command) => {
        if (command.args[0] === "rm") return "";
        executions++;
        return JSON.stringify({
          files: [{ name: "report.txt", base64: Buffer.from("native report").toString("base64") }],
          logs: "done"
        });
      },
      fetch: async (_url, init) => {
        const raw = String(init?.body);
        const body = JSON.parse(raw);
        requests.push(raw);
        expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("container.run");
        expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain(
          "artifact.upload"
        );
        if (requests.length === 1)
          return Response.json({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "generate-report",
                      type: "function",
                      function: {
                        name: "container.run",
                        arguments: JSON.stringify({ script: "pass", outputs: ["report.txt"] })
                      }
                    }
                  ]
                }
              }
            ]
          });
        return Response.json({ choices: [{ message: { content: "报告已生成" } }] });
      }
    });
    try {
      const sessionResult = await assembly.workspace.createSession({ title: "工具工作区", idempotencyKey: "session" });
      const session = sessionResult.session as { id: string; mainlineId: string };
      const run = await assembly.runtime.submitNative({
        sessionId: session.id,
        text: "生成原生报告",
        idempotencyKey: "report"
      });
      await expect.poll(() => assembly.contextStore.runs.get(run.id)?.status).toBe("succeeded");
      expect(executions).toBe(1);
      expect(assembly.contextStore.runs.events(run.id).map((event) => event.type)).toContain("tool_call_succeeded");
      const artifacts = assembly.artifacts.list(session.id, "", 50).items;
      expect(artifacts).toHaveLength(1);
      expect(Buffer.from(assembly.artifacts.read(session.id, artifacts[0]!.id).data).toString()).toBe("native report");
      const original = await assembly.inspection.getSessionGraph(session.id);
      expect(original?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result" })]));
      const history = original!.refs.find((ref) => ref.name === `line:${session.mainlineId}`)!.commitId;
      const later = await assembly.runtime.submitNative({
        sessionId: session.id,
        text: "MAINLINE_FUTURE_ONLY",
        idempotencyKey: "future"
      });
      await expect.poll(() => assembly.contextStore.runs.get(later.id)?.status).toBe("succeeded");
      const { branch } = await assembly.workspace.fork(session.id, {
        commitId: history,
        title: "历史分支",
        idempotencyKey: "fork"
      });
      const alternative = await assembly.runtime.submitNative({
        sessionId: session.id,
        lineId: branch.id,
        text: "探索历史方案",
        idempotencyKey: "branch"
      });
      await expect.poll(() => assembly.contextStore.runs.get(alternative.id)?.status).toBe("succeeded");
      expect(requests.at(-1)).toContain("生成原生报告");
      expect(requests.at(-1)).not.toContain("MAINLINE_FUTURE_ONLY");
      expect(executions).toBe(1);
    } finally {
      await assembly.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
