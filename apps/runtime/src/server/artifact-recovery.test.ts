import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { ArtifactDeliveryStore } from "../composition/artifact-delivery.js";
import { parseConfigObject } from "../config/index.js";
import { createRuntimeFromConfig } from "./runtime-factory.js";

describe("宿主文件回执恢复", () => {
  it.each(["confirmed", "pending", "other-channel"] as const)("启动核对 %s 且不再次调用上传", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-receipt-recovery-"));
    const store = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    try {
      const accepted = await store.acceptNormalizedEvent({
        sessionId: "session",
        platform: "qq",
        provider: "napcat",
        channelId: "qq",
        conversationType: "group",
        conversationId: "123",
        sourceEventId: "source",
        sourceEventType: "message.created",
        senderId: "user",
        text: "报告",
        receivedAt: new Date().toISOString(),
        idempotencyKey: "input"
      });
      const run = store.runs.accept({
        sessionId: "session",
        channelId: "qq",
        sourceEventId: accepted.event.id,
        summary: "报告"
      });
      store.runs.append(run.id, { key: "start", type: "run_started", status: "running", attemptId: "attempt" });
      const payload = { callId: "upload", name: "artifact.upload", input: { artifactId: "file" } };
      store.runs.append(run.id, { key: "tool", type: "tool_call_started", data: payload });
      await store.appendEvent(accepted.mainline.id, {
        type: "tool_call",
        idempotencyKey: "tool:upload:tool_call_started",
        correlationId: "attempt",
        sourceEventId: accepted.lineEvent.id,
        payload
      });
      store.runs.append(run.id, { key: "sent", type: "response_sent" });
      let uploads = 0;
      const deliveries = new ArtifactDeliveryStore(join(directory, "artifact-deliveries"));
      const delivery = deliveries.deliver(
        {
          sessionId: "session",
          channelId: mode === "other-channel" ? "elsewhere" : "qq",
          groupId: "123",
          artifactId: "file"
        },
        async () => {
          uploads++;
          if (mode === "pending") return new Promise(() => {});
          return { status: "succeeded", fileId: "platform-file" };
        }
      );
      if (mode !== "pending") await delivery;
      store.close();
      const instance = createRuntimeFromConfig({
        config: parseConfigObject({ runtime: { dataDir: directory } }),
        channels: new InMemoryChannelRegistry(),
        logger: { info() {}, warn() {}, error() {} }
      });
      try {
        expect(instance.contextStore.runs.get(run.id)?.status).toBe(mode === "confirmed" ? "succeeded" : "uncertain");
        const results = await instance.contextStore.listEvents(accepted.mainline.id, { types: ["tool_result"] });
        expect(results).toHaveLength(mode === "other-channel" ? 0 : 1);
        const recovered = results[0]?.payload as
          | { output?: { status: string; fileId?: string }; recovered?: boolean }
          | undefined;
        expect(recovered?.output?.status).toBe(
          mode === "confirmed" ? "succeeded" : mode === "pending" ? "uncertain" : undefined
        );
        expect(recovered?.output?.fileId).toBe(mode === "confirmed" ? "platform-file" : undefined);
        expect(recovered?.recovered).toBe(mode === "other-channel" ? undefined : true);
        expect(uploads).toBe(1);
      } finally {
        await instance.runtime.dispose();
        instance.contextStore.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
