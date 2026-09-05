import { describe, expect, it } from "vitest";
import { ConsoleLogStore, toStructuredLog } from "./index.js";

describe("ConsoleLogStore", () => {
  it("keeps a bounded log buffer", () => {
    const logger = new ConsoleLogStore(2);

    logger.info("one");
    logger.warn("two", { channelId: "qq" });
    logger.error("three");

    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[0]).toMatchObject({
      level: "warn",
      message: "two",
      metadata: { channelId: "qq" }
    });
    expect(logger.entries[1]).toMatchObject({
      level: "error",
      message: "three"
    });
  });
});

describe("toStructuredLog", () => {
  it("summarizes failed agent runs into readable fields", () => {
    const entry = toStructuredLog({
      id: 1,
      timestamp: "2026-07-11T06:11:32.573Z",
      level: "info",
      message: "Runtime agent run finished.",
      metadata: {
        eventId: "qq-local:11215486",
        runId: "run-qq-local:11215486",
        agentId: "tencent",
        status: "failed",
        error: "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)",
        steps: [{ id: "model-1", kind: "model", status: "failed", detail: "tencent" }]
      }
    });

    expect(entry).toMatchObject({
      kind: "agent",
      status: "failed",
      title: "Agent run finished"
    });
    expect(entry.summary).toContain("event=qq-local:11215486");
    expect(entry.fields).toContainEqual({
      label: "error",
      value: "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)"
    });
    expect(entry.fields).toContainEqual({ label: "steps", value: "model:failed(tencent)" });
  });

  it("summarizes accepted routing events", () => {
    const entry = toStructuredLog({
      id: 2,
      timestamp: "2026-07-11T06:11:31.000Z",
      level: "info",
      message: "Runtime accepted channel event.",
      metadata: {
        eventId: "qq-local:11215486",
        sessionId: "qq:napcat:qq-local:group:807754424",
        userId: "guest:qq:napcat:qq-local:3527968098",
        reason: "keyword",
        trigger: { kind: "keyword", confidence: "heuristic", reason: "keyword" },
        message: { type: "text", segmentTypes: ["text"], textLength: 2, textPreview: "米洛" }
      }
    });

    expect(entry.kind).toBe("routing");
    expect(entry.status).toBe("accepted");
    expect(entry.fields).toContainEqual({ label: "message", value: 'text text 2 chars "米洛"' });
  });
});
