import { describe, expect, it } from "vitest";
import { redactTrace } from "./redact.js";

describe("追踪快照体积边界", () => {
  it("限制宽树、JSON 转义和 UTF-8 的实际字节体积", () => {
    const branch = (depth: number): unknown => (depth === 0 ? 1 : Array.from({ length: 10 }, () => branch(depth - 1)));
    const tree = branch(4);
    for (const value of [tree, Array.from({ length: 100 }, () => "中\u0000".repeat(12_000))]) {
      const serialized = JSON.stringify(redactTrace(value));
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(64_000);
      expect(serialized).toContain("TRUNCATED");
    }
  });

  it("处理循环、二进制和嵌入错误正文的凭据", () => {
    const cycle: Record<string, unknown> = { error: new Error("failed: canary-key"), bytes: new Uint8Array(100) };
    cycle.self = cycle;
    const serialized = JSON.stringify(redactTrace(cycle, ["canary-key"]));
    expect(serialized).not.toContain("canary-key");
    expect(serialized).toContain("CIRCULAR");
    expect(serialized).toContain("BINARY OMITTED");
  });
});
