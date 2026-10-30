import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { RunRecorder } from "../../../src/trace/recorder.js";

async function createRecoveryFixture() {
  const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
  onTestFinished(() => store.close());
  const accepted = await store.acceptNormalizedEvent({
    sessionId: "session",
    platform: "qq",
    provider: "napcat",
    channelId: "channel",
    conversationType: "group",
    conversationId: "group",
    sourceEventId: "platform-event",
    sourceEventType: "message.created",
    senderId: "user",
    text: "生成报告",
    receivedAt: new Date().toISOString(),
    idempotencyKey: "input"
  });
  const run = store.runs.accept({
    sessionId: "session",
    channelId: "channel",
    sourceEventId: accepted.event.id,
    lineId: accepted.mainline.id,
    summary: "生成报告"
  });
  const recorder = new RunRecorder(run.id, store.runs);
  const receipt = async (type: string, payload: Record<string, unknown>, correlationId = recorder.attemptId) => {
    return store.appendEvent(accepted.mainline.id, {
      type,
      payload,
      correlationId,
      sourceEventId: accepted.lineEvent.id,
      idempotencyKey: `receipt:${type}:${JSON.stringify(payload)}`
    });
  };
  return { store, run, recorder, accepted, receipt };
}

describe("崩溃窗口回执核对", () => {
  it("原始工具和发送回执已落盘时补齐成功且重复恢复不追加", async () => {
    const { store, run, recorder, accepted, receipt } = await createRecoveryFixture();
    recorder.emit("tool_call_started", { callId: "upload", name: "artifact.upload" });
    await receipt("tool_result", {
      callId: "upload",
      name: "artifact.upload",
      status: "succeeded",
      output: { status: "succeeded", artifactId: "artifact", fileId: "platform-file" }
    });
    recorder.emit("response_sending");
    await receipt("delivery_succeeded", { runId: run.id, result: { messageId: "platform-reply" } }, accepted.event.id);
    store.runs.recover();
    expect(store.runs.get(run.id)?.status).toBe("succeeded");
    expect(
      store.runs.events(run.id).filter((event) => (event.data as { recovered?: boolean } | null)?.recovered)
    ).toHaveLength(2);
    const cursor = store.runs.highWaterMark();
    store.runs.recover();
    expect(store.runs.highWaterMark()).toBe(cursor);
  });

  it("单靠回复回执不消除没有结果的工具调用", async () => {
    const { store, run, recorder, accepted, receipt } = await createRecoveryFixture();
    recorder.emit("tool_call_started", { callId: "unknown" });
    await receipt("delivery_succeeded", { runId: run.id }, accepted.event.id);
    store.runs.recover();
    expect(store.runs.get(run.id)?.status).toBe("uncertain");
  });

  it("已经生成但未上传的工件不能被最终文本包装为成功", async () => {
    const { store, run, recorder } = await createRecoveryFixture();
    recorder.emit("tool_call_succeeded", {
      name: "container.run",
      callId: "generate",
      output: { status: "generated", artifacts: [{ id: "file" }] }
    });
    recorder.emit("response_sent");
    store.runs.recover();
    expect(store.runs.get(run.id)).toMatchObject({ status: "failed", error: { code: "artifact_not_delivered" } });
  });

  it("模型失败后发送说明仍为失败，旧尝试失败不污染恢复后的成功", async () => {
    const first = await createRecoveryFixture();
    first.recorder.emit("response_sent");
    await first.receipt("agent_run_failed", { status: "failed" });
    first.store.runs.recover();
    expect(first.store.runs.get(first.run.id)?.status).toBe("failed");
    const second = await createRecoveryFixture();
    await second.receipt("agent_run_failed", { status: "failed" }, "old-attempt");
    second.recorder.emit("response_sent");
    second.store.runs.recover();
    expect(second.store.runs.get(second.run.id)?.status).toBe("succeeded");
  });

  it("容器失败必须被后续实际生成和交付修正，实时与恢复判断一致", async () => {
    for (const repair of [false, true]) {
      const { store, run, recorder } = await createRecoveryFixture();
      recorder.emit("tool_call_succeeded", { name: "container.run", output: { status: "failed" } });
      if (repair) {
        recorder.emit("tool_call_succeeded", {
          name: "container.run",
          output: { status: "generated", artifacts: [{ id: "file" }] }
        });
        recorder.emit("tool_call_succeeded", {
          name: "artifact.upload",
          output: { status: "succeeded", artifactId: "file" }
        });
      }
      recorder.emit("response_sent");
      recorder.finish();
      expect(store.runs.get(run.id)?.status).toBe(repair ? "succeeded" : "failed");
    }
  });

  it("超过单页的事件仍准确配对，工具超时的原始回执保留未知状态", async () => {
    const { store, run, recorder, receipt } = await createRecoveryFixture();
    recorder.emit("tool_call_started", { callId: "slow" });
    for (let i = 0; i < 205; i++) recorder.emit("model_call_succeeded", { index: i });
    await receipt("tool_result", {
      callId: "slow",
      status: "failed",
      error: { name: "ToolCallRecoveryError", code: "outcome_uncertain" }
    });
    store.runs.recover();
    expect(store.runs.get(run.id)?.status).toBe("uncertain");
  });
});
