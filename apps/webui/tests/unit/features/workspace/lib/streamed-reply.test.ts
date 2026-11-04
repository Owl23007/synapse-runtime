import { expect, it } from "vitest";
import type { RunEvent } from "@synapse/runtime-client";
import { streamedReply } from "../../../../../src/features/workspace/lib/streamed-reply.js";

function event(type: string, content?: string, modelCallId = "model-1", attemptId = "attempt-1"): RunEvent {
  return {
    id: "event",
    protocolVersion: 1,
    runId: "run",
    seq: 1,
    cursor: 1,
    type,
    attemptId,
    occurredAt: "2026-01-01T00:00:00Z",
    data: { modelCallId, content }
  };
}
it("快照替换正文并在新步骤或重试时隔离旧内容", () => {
  const events = [event("model_call_started"), event("model_output", "你"), event("model_output", "你好")];
  expect(streamedReply(events)).toBe("你好");
  expect(streamedReply([...events, event("model_call_succeeded", "你好！")])).toBe("你好！");
  expect(streamedReply([...events, event("model_call_started", undefined, "model-2")])).toBe("");
  expect(
    streamedReply([
      ...events,
      event("model_call_started", undefined, "model-1", "retry"),
      event("model_output", "迟到的内容")
    ])
  ).toBe("");
});
