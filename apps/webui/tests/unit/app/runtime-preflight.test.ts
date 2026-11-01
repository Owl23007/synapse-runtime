import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRuntime } from "../../../src/app/runtime-preflight.js";

afterEach(() => vi.unstubAllGlobals());

describe("受信任的跨源连接", () => {
  const origin = "http://localhost:5173";
  const endpoint = "http://127.0.0.1:3766";

  it("不同 localhost 源也先检查来源，预检无凭据，通过后才发送 Token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, protocolVersion: 1, allowedOrigin: origin }))
      .mockResolvedValueOnce(Response.json({ ok: true, protocolVersion: 1 }));
    vi.stubGlobal("fetch", fetcher);
    await connectRuntime(endpoint, "secret", origin);
    expect(fetcher.mock.calls[0]).toEqual([
      `${endpoint}/admin/connection`,
      expect.objectContaining({ credentials: "omit", redirect: "error", mode: "cors" })
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetcher.mock.calls[1]).toEqual([
      `${endpoint}/admin/status`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer secret" })
      })
    ]);
  });

  it("来源不匹配、旧版服务、网络错误或拒绝响应均不会发送 Token", async () => {
    for (const response of [
      Response.json({ ok: true, protocolVersion: 1, allowedOrigin: "https://other.example" }),
      Response.json({ ok: true }),
      Response.json({ ok: false }, { status: 403 }),
      new TypeError("Failed to fetch")
    ]) {
      const fetcher = vi.fn<typeof fetch>();
      if (response instanceof Error) fetcher.mockRejectedValue(response);
      else fetcher.mockResolvedValue(response);
      vi.stubGlobal("fetch", fetcher);
      await expect(connectRuntime(endpoint, "secret", origin)).rejects.toThrow("admin.allowedOrigins");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
    }
  });

  it("同源继续直接认证，保留 Vite Proxy 入口", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ protocolVersion: 1 }));
    vi.stubGlobal("fetch", fetcher);
    await connectRuntime(origin, "secret", origin);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${origin}/admin/status`);
  });

  it("远程明文 HTTP 在任何网络请求前拒绝携带 Token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(connectRuntime("http://remote.example", "secret", origin)).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
