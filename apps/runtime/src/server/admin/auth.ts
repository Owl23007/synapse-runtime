import type { AdminSettings } from "../../config/index.js";
import type { NovaRequest, NovaResponse } from "nova-http";
import { sendJson } from "../http.js";

const ADMIN_CORS_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
const ADMIN_CORS_HEADERS = ["authorization", "content-type", "last-event-id", "accept"];

/** 管理请求先校验来源与网络边界，预检仅公开来源支持，业务接口仍需令牌认证 */
export function authorizeAdminRequest(admin: AdminSettings, request: NovaRequest, response: NovaResponse): boolean {
  const origin = request.getHeader("origin");
  response.setHeader("vary", "Origin");

  if (origin !== undefined && !admin.allowedOrigins.includes(origin)) {
    sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
    return false;
  }

  if (!admin.allowedRemoteAddresses.includes(request.ip)) {
    sendJson(response, 403, { ok: false, error: "remote_address_not_allowed" });
    return false;
  }

  if (origin !== undefined) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-expose-headers", "content-disposition, retry-after");
  }

  if (request.method === "OPTIONS") {
    const method = request.getHeader("access-control-request-method");
    const headers = (request.getHeader("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (
      !origin ||
      !method ||
      !ADMIN_CORS_METHODS.includes(method) ||
      headers.some((header) => !ADMIN_CORS_HEADERS.includes(header))
    ) {
      sendJson(response, 403, { ok: false, error: "preflight_not_allowed" });
      return false;
    }
    response
      .status(204)
      .setHeader("access-control-allow-methods", ADMIN_CORS_METHODS.join(", "))
      .setHeader("access-control-allow-headers", ADMIN_CORS_HEADERS.join(", "))
      .setHeader("cache-control", "no-store")
      .end();
    return false;
  }

  if (request.method === "GET" && request.pathname === "/admin/connection") {
    response.setHeader("cache-control", "no-store");
    sendJson(response, 200, { ok: true, protocolVersion: 1, allowedOrigin: origin ?? null });
    return false;
  }

  if (admin.token === undefined) {
    return true;
  }

  if (request.getHeader("authorization") !== `Bearer ${admin.token}`) {
    sendJson(response, 401, { ok: false, error: "invalid_admin_token" });
    return false;
  }

  return true;
}

export function validateAdminSecurity(admin: AdminSettings): void {
  if (!admin.enabled || isLoopbackHost(admin.host)) {
    return;
  }

  // Remote Admin API must be explicitly token-protected when exposed beyond loopback.
  if (admin.token === undefined) {
    throw new Error("Remote admin API requires admin.token. Keep admin.host on 127.0.0.1 for local development.");
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
