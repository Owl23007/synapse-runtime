import type { AdminSettings } from "@synapse/runtime-config";
import type { NovaRequest, NovaResponse } from "nova-http";
import { sendJson } from "../http.js";

export function authorizeAdminRequest(admin: AdminSettings, request: NovaRequest, response: NovaResponse): boolean {
  const origin = request.getHeader("origin");

  if (origin !== undefined && !admin.allowedOrigins.includes(origin)) {
    sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
    return false;
  }

  if (!admin.allowedRemoteAddresses.includes(request.ip)) {
    sendJson(response, 403, { ok: false, error: "remote_address_not_allowed" });
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
