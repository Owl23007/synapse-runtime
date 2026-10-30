import { describe, expect, it } from "vitest";
import { type RunTrace } from "@synapse/runtime-client";
import { durationLabel, runDuration, shortTime } from "../../../../src/features/runs/run-presentation.js";

const run: RunTrace = {
  id: "run-test",
  protocolVersion: 1,
  sourceEventId: "source",
  sessionId: "session",
  channelId: "native",
  status: "running",
  phase: "model",
  startedAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:01.000Z",
  summary: "测试",
  lastSeq: 1
};

describe("运行耗时展示", () => {
  it("区分缺失耗时与已记录的零耗时", () => {
    expect(durationLabel(undefined)).toBe("未记录");
    expect(durationLabel(NaN)).toBe("未记录");
    expect(durationLabel(-1)).toBe("未记录");
    expect(durationLabel(0)).toBe("0 ms");
    expect(durationLabel(128)).toBe("128 ms");
    expect(durationLabel(18400)).toBe("18.4 s");
    expect(durationLabel(125000)).toBe("2:05");
  });
  it("仅让活跃运行继续计时，终态缺失结束时间时保留未知", () => {
    const now = Date.parse("2026-10-29T00:00:12.000Z");
    expect(runDuration(run, now)).toBe(12000);
    expect(runDuration({ ...run, status: "accepted" }, now)).toBe(12000);
    expect(runDuration({ ...run, status: "failed" }, now)).toBeUndefined();
    expect(runDuration({ ...run, status: "succeeded", finishedAt: "2026-10-29T00:00:02.000Z" }, now)).toBe(2000);
  });
  it("非法时间与时钟倒退不产生负数或无效文本", () => {
    expect(runDuration({ ...run, startedAt: "invalid" })).toBeUndefined();
    expect(runDuration(run, Date.parse("2026-10-28T00:00:00.000Z"))).toBeUndefined();
    expect(shortTime("invalid")).toBe("未记录");
  });
});
