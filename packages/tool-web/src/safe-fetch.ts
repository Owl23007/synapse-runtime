import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { assertFetchTarget, assertHttpUrl, defaultLookup } from "./target-policy.js";

/** 受控 HTTP 请求策略，私网例外必须精确来自管理员白名单 */
export interface SafeFetchPolicy {
  /** 受控宿主可注入 DNS，校验和实际连接始终使用同一结果 */
  readonly lookup?: typeof defaultLookup;
  readonly allowedHosts?: readonly string[];
  readonly privateHosts?: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs?: number;
}

/** DNS 校验与连接共用同一解析结果，避免检查后重新解析造成 DNS 重绑定 */
export function createSafeFetch(policy: SafeFetchPolicy): typeof fetch {
  return async (input, init) => {
    const original = new Request(input, init);
    const body = original.body ? Buffer.from(await original.arrayBuffer()) : undefined;
    const signal = AbortSignal.any([original.signal, AbortSignal.timeout(policy.timeoutMs ?? 60_000)]);
    let url = new URL(original.url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      assertHttpUrl(url);
      if (policy.allowedHosts?.length && !policy.allowedHosts.includes(url.hostname))
        throw new Error("HTTP host is not allowed");
      const addresses = await (policy.lookup ?? defaultLookup)(url.hostname.replace(/^\[|\]$/g, ""));
      await assertFetchTarget(url, {
        allowedDomains: [],
        deniedDomains: [],
        allowPrivateNetwork: policy.privateHosts?.includes(url.hostname) ?? false,
        lookup: async () => addresses
      });
      if (!addresses[0]) throw new Error("HTTP host did not resolve");
      const address = addresses[0];
      const response = await new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(original.headers);
        // 目标主机及内容长度交给 HTTP 实现，禁止调用者覆盖连接目的地
        delete headers.host;
        delete headers["content-length"];
        delete headers["connection"];
        delete headers["transfer-encoding"];
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            method: original.method,
            family: address.family,
            headers,
            signal,
            lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
          },
          (incoming) => {
            const status = incoming.statusCode ?? 502;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers))
              if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            const length = Number(responseHeaders.get("content-length"));
            if (length > policy.maxBytes) {
              incoming.destroy();
              reject(new Error("HTTP response too large"));
              return;
            }
            let bytes = 0;
            const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
            const bounded = stream.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.length;
                  if (bytes > policy.maxBytes) throw new Error("HTTP response too large");
                  controller.enqueue(chunk);
                }
              })
            );
            if ([204, 205, 304].includes(status)) {
              incoming.resume();
              resolve(new Response(null, { status, headers: responseHeaders }));
            } else resolve(new Response(bounded, { status, headers: responseHeaders }));
          }
        );
        request.once("error", () => reject(new Error(signal.aborted ? "HTTP request aborted" : "HTTP request failed")));
        request.end(body);
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      if (original.redirect === "manual") return response;
      const location = response.headers.get("location");
      if (!location || redirects === 3 || original.redirect === "error" || original.method !== "GET")
        throw new Error("HTTP redirect rejected");
      const target = new URL(location, url);
      if (url.protocol === "https:" && target.protocol !== "https:")
        throw new Error("HTTPS downgrade redirect rejected");
      if (target.origin !== url.origin && original.headers.has("authorization"))
        throw new Error("Credentialed cross-origin redirect rejected");
      url = target;
    }
    throw new Error("HTTP redirect limit exceeded");
  };
}
