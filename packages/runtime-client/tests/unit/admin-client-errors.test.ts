import { describe, expect, it } from "vitest";
import { RuntimeAdminClient } from "../../src/admin-client.js";

function client(response: Response) {
  return new RuntimeAdminClient({ endpoint: "http://127.0.0.1:3766", fetch: async () => response });
}

describe("管理 API 错误响应", () => {
  it.each([500, 502, 503, 504])("代理返回空正文时保留 HTTP %s 并提示检查服务", async (status) => {
    const request = client(new Response(null, { status })).status();
    await expect(request).rejects.toThrow(`HTTP ${status}`);
    await expect(request).rejects.toThrow("请检查 Runtime 是否启动及代理目标地址");
  });

  it("HTML 错误页不会覆盖认证错误或泄露正文", async () => {
    const request = client(new Response("<html>private proxy details</html>", { status: 401 })).status();
    await expect(request).rejects.toThrow("HTTP 401");
    await expect(request).rejects.toThrow("请检查访问令牌");
    await expect(request).rejects.not.toThrow("private proxy details");
  });

  it("保留服务端 JSON 错误详情", async () => {
    await expect(client(Response.json({ error: "session_not_found" }, { status: 404 })).status()).rejects.toThrow(
      'Admin API 请求失败（HTTP 404）: {"error":"session_not_found"}'
    );
  });

  it.each(["", "<html>WebUI</html>", '{"ok":'])("成功状态的异常正文也提供服务配置提示：%j", async (body) => {
    await expect(client(new Response(body)).status()).rejects.toThrow(
      "Runtime 返回了空响应或无效的 JSON（HTTP 200），请检查服务地址及代理配置"
    );
  });

  it("网络断连时提供连接提示并保留底层原因", async () => {
    const cause = new TypeError("fetch failed");
    const runtime = new RuntimeAdminClient({
      endpoint: "http://127.0.0.1:3766",
      fetch: async () => {
        throw cause;
      }
    });
    await expect(runtime.status()).rejects.toMatchObject({
      message: "无法连接 Runtime，请检查服务是否启动、服务地址及网络连接",
      cause
    });
  });

  it("正常 JSON 响应保持原样", async () => {
    await expect(client(Response.json({ ok: true, protocolVersion: 1 })).status()).resolves.toEqual({
      ok: true,
      protocolVersion: 1
    });
  });
});
