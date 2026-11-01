import { RuntimeAdminClient } from "@synapse/runtime-client";
import { normalizeEndpoint, record } from "../shared/lib/runtime.js";
import { isLocalEndpoint } from "./saved-connections.js";

/** 跨源认证前探测目标对当前 WebUI 来源的支持，不发送令牌、Cookie 或跟随重定向 */
export async function checkRuntimeOrigin(endpoint: string, origin: string): Promise<void> {
  if (endpoint === origin) return;
  try {
    const response = await fetch(`${endpoint}/admin/connection`, {
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    const body = record(await response.json());
    if (!response.ok || body.ok !== true || body.protocolVersion !== 1 || body.allowedOrigin !== origin)
      throw new Error("unsupported_origin");
  } catch {
    throw new Error("无法确认目标 Runtime 支持当前来源，请检查服务地址、网络及目标的 admin.allowedOrigins 配置");
  }
}

/** 完成无凭据来源检查后才认证，后续 JSON、下载与 SSE 请求均禁止跳转及隐式 Cookie */
export async function connectRuntime(endpoint: string, token: string, origin: string): Promise<RuntimeAdminClient> {
  const target = normalizeEndpoint(endpoint);
  if (token && new URL(target).protocol !== "https:" && !isLocalEndpoint(target))
    throw new Error("请使用 HTTPS 服务地址，避免令牌通过明文网络传输");
  await checkRuntimeOrigin(target, origin);
  const client = new RuntimeAdminClient({
    endpoint: target,
    ...(token ? { token } : {}),
    fetch: (url, init) => fetch(url, { ...init, mode: "cors", credentials: "omit", redirect: "error" })
  });
  const status = record(await client.status());
  if (status.protocolVersion !== 1) throw new Error("服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本");
  return client;
}
