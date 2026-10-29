import { describe, expect, it } from "vitest";
import { mergeEvents, normalizeEndpoint, time } from "./runtime.js";
import { type RunEvent } from "@synapse/runtime-client";

describe("浏览器数据边界", () => {
  it("补读和实时流交错时去重排序，切换运行不混入旧事件", () => {
    const event = (runId: string, seq: number): RunEvent => ({
      id: `${runId}:${seq}`,
      runId,
      seq,
      cursor: seq,
      protocolVersion: 1,
      type: "run_started",
      occurredAt: "2026-10-25T00:00:00Z",
      data: {}
    });
    expect(mergeEvents("a", [event("a", 3), event("b", 1)], [event("a", 2), event("a", 3)]).map((e) => e.seq)).toEqual([
      2, 3
    ]);
  });
  it("连接信息禁止将令牌放进地址或使用执行脚本协议", () => {
    for (const input of [
      "javascript:alert(1)",
      "https://token@host",
      "https://host?token=secret",
      "https://host/#secret",
      "https://host/admin"
    ])
      expect(() => normalizeEndpoint(input)).toThrow();
    expect(normalizeEndpoint("http://localhost:3766/")).toBe("http://localhost:3766");
    expect(time("invalid")).toBe("未记录");
  });
});
