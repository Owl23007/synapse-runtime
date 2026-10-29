import { describe, expect, it } from "vitest";
import type { RunEvent } from "@synapse/runtime-client";
import { sessionDay, toolActivities } from "./workspace-model.js";

function event(type: string, seq: number, data: unknown = { callId: "read-1" }, attemptId = "attempt-1"): RunEvent {
  return {
    id: `event-${seq}`,
    protocolVersion: 1,
    runId: "run-1",
    seq,
    cursor: seq,
    type,
    occurredAt: new Date(2026, 9, 29, 12, 0, seq).toISOString(),
    attemptId,
    data
  };
}

describe("工作台事件与日期投影", () => {
  it("按执行尝试配对工具回执，保留输入与真实结果", () => {
    const calls = toolActivities(
      [
        event("tool_call_started", 1, { callId: "read-1", name: "read_file", input: { path: "src/main.ts" } }),
        event("tool_call_failed", 2, { callId: "read-1", error: { message: "not found" } }),
        event(
          "tool_call_started",
          3,
          { callId: "read-1", name: "read_file", input: { path: "src/app.ts" } },
          "attempt-2"
        ),
        event("tool_call_succeeded", 4, { callId: "read-1", output: "source" }, "attempt-2")
      ],
      "succeeded"
    );
    expect(calls.map((call) => call.status)).toEqual(["failed", "succeeded"]);
    expect(calls[1]?.input).toEqual({ path: "src/app.ts" });
    expect(calls[1]?.output).toBe("source");
    expect(calls[1]?.durationMs).toBeUndefined();
  });

  it("运行完成、回执复用和缺失调用 ID 都不能制造工具成功", () => {
    expect(toolActivities([event("tool_call_started", 1)], "succeeded")[0]?.status).toBe("unrecorded");
    expect(toolActivities([event("tool_call_started", 1)], "uncertain")[0]?.status).toBe("uncertain");
    expect(toolActivities([event("tool_call_replayed", 1)], "succeeded")[0]?.status).toBe("unrecorded");
    expect(
      toolActivities([event("tool_call_started", 1, {}), event("tool_call_succeeded", 2, {})], "succeeded")
    ).toHaveLength(2);
  });

  it("未知副作用与权限受阻保留明确状态", () => {
    expect(
      toolActivities(
        [event("tool_call_failed", 1, { callId: "write-1", error: { code: "outcome_uncertain" } })],
        "failed"
      )[0]?.status
    ).toBe("uncertain");
    expect(toolActivities([event("tool_call_blocked", 1)], "blocked")[0]?.status).toBe("blocked");
  });

  it("按本地自然日处理跨月与无效日期", () => {
    const now = new Date(2026, 10, 1, 0, 5);
    expect(sessionDay(new Date(2026, 10, 1, 0, 1).toISOString(), now)).toBe("今天");
    expect(sessionDay(new Date(2026, 9, 31, 23, 59).toISOString(), now)).toBe("昨天");
    expect(sessionDay(new Date(2026, 9, 29).toISOString(), now)).toBe("更早");
    expect(sessionDay(undefined, now)).toBe("更早");
  });
});
