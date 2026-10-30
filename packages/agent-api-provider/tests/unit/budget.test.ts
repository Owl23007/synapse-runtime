import { describe, expect, it } from "vitest";
import { OpenAiCompatibleChatProvider } from "../../src/provider.js";

const options = { id: "test", apiKey: "test-secret", baseUrl: "https://model.invalid", model: "test" };
describe("模型请求预算", () => {
  it("响应体一直不结束也会超时，并把取消信号传到 HTTP", async () => {
    let signal: AbortSignal | undefined;
    const provider = new OpenAiCompatibleChatProvider({
      ...options,
      timeoutMs: 25,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      }
    });
    await expect(provider.complete({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow("超时");
    expect(signal?.aborted).toBe(true);
  });
  it("完整 HTTP 载荷超限时拒绝调用，包含额外参数而非只统计用户文本", async () => {
    let called = false;
    const provider = new OpenAiCompatibleChatProvider({
      ...options,
      maxRequestChars: 100,
      extraBody: { metadata: "x".repeat(200) },
      fetch: async () => {
        called = true;
        throw new Error("must not call");
      }
    });
    await expect(provider.complete({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow("字符上限");
    expect(called).toBe(false);
  });
  it("已经取消的请求不会访问模型服务", async () => {
    const provider = new OpenAiCompatibleChatProvider({
      ...options,
      fetch: async () => {
        throw new Error("must not call");
      }
    });
    await expect(provider.complete({ messages: [], signal: AbortSignal.abort(new Error("stopped")) })).rejects.toThrow(
      "stopped"
    );
  });
});
