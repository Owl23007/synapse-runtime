import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";

describe("自动附件回执恢复", () => {
  it.each([false, true])("恢复独立上传回执而不推测文本发送，回复已确认=%s", async (confirmedReply) => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    onTestFinished(() => store.close());
    try {
      const input = await store.acceptNormalizedEvent({
        sessionId: "session",
        platform: "qq",
        provider: "napcat",
        channelId: "qq",
        conversationType: "group",
        conversationId: "123",
        sourceEventId: "source",
        sourceEventType: "message.created",
        senderId: "user",
        text: "report",
        receivedAt: new Date().toISOString(),
        idempotencyKey: "input"
      });
      const run = store.runs.accept({
        sessionId: "session",
        channelId: "qq",
        sourceEventId: input.event.id,
        summary: "report"
      });
      store.runs.append(run.id, { key: "start", type: "run_started", status: "running", attemptId: "attempt" });
      store.runs.append(run.id, { key: "response", type: "response_sending" });
      store.runs.append(run.id, {
        key: "upload",
        type: "artifact_upload_started",
        data: { artifactId: "file", automatic: true }
      });
      if (confirmedReply)
        await store.appendEvent(input.mainline.id, {
          type: "delivery_succeeded",
          idempotencyKey: "sent",
          correlationId: input.event.id,
          payload: { runId: run.id, artifactIds: ["file"] }
        });
      const inspected: unknown[] = [];
      store.recoverRuns((request) => {
        inspected.push(request);
        return { status: "succeeded", artifactId: "file", fileId: "receipt" };
      });
      expect(inspected).toEqual([
        {
          sessionId: "session",
          channelId: "qq",
          conversationId: "123",
          conversationType: "group",
          name: "artifact.upload",
          input: { artifactId: "file" }
        }
      ]);
      expect(store.runs.get(run.id)?.status).toBe(confirmedReply ? "succeeded" : "uncertain");
      expect(store.runs.latestEvent(run.id, "artifact_upload_succeeded")?.data).toMatchObject({
        artifactId: "file",
        fileId: "receipt",
        recovered: true
      });
      const cursor = store.runs.highWaterMark();
      store.recoverRuns(() => {
        throw new Error("终态不得再次核对或重放");
      });
      expect(store.runs.highWaterMark()).toBe(cursor);
    } finally {
      store.close();
    }
  });
});
