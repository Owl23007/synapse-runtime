import { afterEach, describe, expect, it, vi } from "vitest";
import { OneBot11ChannelAdapter } from "../../src/adapter.js";
import type { OneBot11Fetch } from "../../src/types.js";

describe("群文件上传的未知结果边界", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["headers", "body"])("%s 阶段挂起时中止请求并返回未知结果", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: OneBot11Fetch = async (_url, init) => {
      signal = init?.signal;
      const pending = new Promise<never>(() => {});
      return phase === "headers" ? pending : { ok: true, status: 200, json: () => pending };
    };
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://napcat.invalid",
      requestTimeoutMs: 50,
      fetch
    });
    const result = adapter.uploadGroupFile("123", { name: "a.txt", data: Buffer.from("a") });
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "uncertain" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{}, { status: "async", retcode: 1 }, { status: "ok", retcode: 1 }])(
    "不把未确认终态的回执 %j 当作明确失败或成功",
    async (payload) => {
      const adapter = new OneBot11ChannelAdapter({
        id: "qq",
        transport: "http",
        endpoint: "http://napcat.invalid",
        fetch: async () => Response.json(payload)
      });
      expect(await adapter.uploadGroupFile("123", { name: "a.txt", data: Buffer.from("a") })).toMatchObject({
        status: "uncertain"
      });
    }
  );
});
