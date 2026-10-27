import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { OneBot11ChannelAdapter } from "@synapse/runtime-channel-onebot11";
import { parseConfigObject } from "../config/index.js";
import { createRuntimeFromConfig } from "./runtime-factory.js";

describe("显式群工件选择", () => {
  it("选择和废弃不调用平台，未选中不可上传，重复交付复用回执", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-upload-selection-"));
    const channels = new InMemoryChannelRegistry();
    let uploads = 0;
    channels.register(
      new OneBot11ChannelAdapter({
        id: "qq",
        endpoint: "https://napcat.invalid",
        transport: "http",
        fetch: async () => {
          uploads++;
          return Response.json({ status: "ok", retcode: 0 });
        }
      })
    );
    const instance = createRuntimeFromConfig({
      config: parseConfigObject({
        runtime: { dataDir: directory },
        container: { enabled: true },
        permissions: { "container.execute": "allow", "channel.qq.upload_group_file": "allow" }
      }),
      channels,
      logger: { info() {}, warn() {}, error() {} },
      containerRunner: async (command) =>
        command.args[0] === "rm"
          ? ""
          : JSON.stringify({
              files: [
                { name: "report.txt", base64: "YQ==" },
                { name: "draft.txt", base64: "Yg==" }
              ],
              logs: ""
            })
    });
    const context = {
      sessionId: "session",
      runId: "run",
      userId: "user",
      source: { channelId: "qq", conversationKind: "group", conversationId: "123" }
    };
    try {
      const generated = await instance.tools.call<{ artifacts: { id: string }[] }>(
        "container.run",
        { script: "pass", outputs: ["report.txt", "draft.txt"] },
        { ...context, callId: "generate" }
      );
      const [report, draft] = generated.output!.artifacts;
      const selected = await instance.tools.call(
        "artifact.upload",
        { operation: "select", artifactIds: [report!.id] },
        { ...context, callId: "select" }
      );
      expect(selected.output).toMatchObject({ status: "selected", selection: { selectedIds: [report!.id] } });
      const discarded = await instance.tools.call(
        "artifact.upload",
        { operation: "discard", artifactIds: [draft!.id] },
        { ...context, callId: "discard" }
      );
      expect(discarded.output).toMatchObject({ status: "discarded" });
      expect(uploads).toBe(0);
      await expect(
        instance.tools.call("artifact.upload", { artifactId: draft!.id }, { ...context, callId: "draft-upload" })
      ).rejects.toThrow("最终产物");
      await instance.tools.call("artifact.upload", { artifactId: report!.id }, { ...context, callId: "upload" });
      await instance.tools.call("artifact.upload", { artifactId: report!.id }, { ...context, callId: "repeat" });
      expect(uploads).toBe(1);
    } finally {
      await instance.runtime.dispose();
      instance.contextStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
