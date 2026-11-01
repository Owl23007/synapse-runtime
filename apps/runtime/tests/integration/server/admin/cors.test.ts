import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseConfigObject } from "../../../../src/config/index.js";
import { createAdminServerFixture } from "../../../helpers/admin-server.js";

async function fixture(allowedRemoteAddresses = ["127.0.0.1", "::1"]) {
  const directory = mkdtempSync(join(tmpdir(), "synapse-admin-cors-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return createAdminServerFixture(
    parseConfigObject({
      runtime: { dataDir: directory },
      server: { host: "127.0.0.1", port: 0 },
      admin: {
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        allowedOrigins: ["https://webui.example"],
        allowedRemoteAddresses
      }
    })
  );
}

describe("管理接口的受信任跨源连接", () => {
  const origin = "https://webui.example";

  it("信任来源可无 Token 探测及预检，业务读取、写入和流仍需认证", async () => {
    const { endpoint } = await fixture();
    const probe = await fetch(`${endpoint}/admin/connection`, { headers: { origin } });
    expect(await probe.json()).toEqual({ ok: true, protocolVersion: 1, allowedOrigin: origin });
    expect(probe.headers.get("access-control-allow-origin")).toBe(origin);
    expect(probe.headers.get("cache-control")).toBe("no-store");
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await fetch(`${endpoint}/admin/status`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "Authorization, Content-Type, Last-Event-ID"
        }
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toContain(method);
      expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    }
    for (const [path, method] of [
      ["/admin/status", "GET"],
      ["/admin/sessions", "POST"],
      ["/admin/run-events/stream", "GET"]
    ] as const) {
      const response = await fetch(`${endpoint}${path}`, { method, headers: { origin } });
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
    const status = await fetch(`${endpoint}/admin/status`, { headers: { origin, authorization: "Bearer secret" } });
    expect(status.status).toBe(200);
    expect(status.headers.get("access-control-allow-origin")).toBe(origin);
    expect(status.headers.get("vary")).toContain("Origin");
    const stream = await fetch(`${endpoint}/admin/run-events/stream`, {
      headers: { origin, authorization: "Bearer secret", "last-event-id": "0" }
    });
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get("access-control-allow-origin")).toBe(origin);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      await stream.body?.cancel();
    }
  });

  it("不信任来源、未知预检头和方法均拒绝，不添加 localhost 特例", async () => {
    const { endpoint } = await fixture();
    for (const untrusted of ["https://evil.example", "http://localhost:5173", "null"]) {
      const response = await fetch(`${endpoint}/admin/connection`, { headers: { origin: untrusted } });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const headers of [
      { origin, "access-control-request-method": "TRACE" },
      { origin, "access-control-request-method": "GET", "access-control-request-headers": "x-untrusted" }
    ])
      expect((await fetch(`${endpoint}/admin/status`, { method: "OPTIONS", headers })).status).toBe(403);
  });

  it("可信来源不能绕过远程地址限制", async () => {
    const { endpoint } = await fixture(["192.0.2.1"]);
    expect((await fetch(`${endpoint}/admin/connection`, { headers: { origin } })).status).toBe(403);
    expect(
      (
        await fetch(`${endpoint}/admin/status`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "GET" }
        })
      ).status
    ).toBe(403);
  });
});
