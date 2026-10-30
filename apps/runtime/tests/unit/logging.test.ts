import { describe, expect, it } from "vitest";
import { createLevelLogger, RuntimeLogBuffer } from "../../src/logging.js";
import { collectTraceSecrets } from "../../src/secrets.js";

describe("日志脱敏边界", () => {
  it("在缓冲区与订阅收到日志前清除正文和错误中的配置凭据", () => {
    const buffer = new RuntimeLogBuffer(5);
    const observed: unknown[] = [];
    buffer.subscribe((entry) => observed.push(entry));
    const secrets = collectTraceSecrets({
      provider: { apiKey: "secret-canary", headers: { "x-vendor": "header-canary" } }
    });
    const logger = createLevelLogger(buffer, "info", () => secrets);
    logger.error("request secret-canary failed", {
      error: new Error("upstream header-canary failed"),
      token: "unconfigured-token",
      safe: "normal"
    });
    for (const output of [buffer.entries, observed]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toMatch(/secret-canary|header-canary|unconfigured-token/);
      expect(serialized).toContain("normal");
      expect(serialized).toContain("REDACTED");
    }
  });

  it("限制复杂元数据并保持级别过滤", () => {
    const buffer = new RuntimeLogBuffer(5);
    const logger = createLevelLogger(buffer, "warn");
    const circular: Record<string, unknown> = { data: Array.from({ length: 100 }, () => "中".repeat(20_000)) };
    circular.self = circular;
    logger.info("ignored");
    logger.warn("large", circular);
    expect(buffer.entries).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(buffer.entries))).toBeLessThan(65_000);
  });
});
