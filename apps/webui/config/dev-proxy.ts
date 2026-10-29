import type { ProxyOptions } from "vite";

/** 本地预览只改写自身同源请求，沿用 SSH 隧道与服务端的认证和来源边界 */
export function runtimeProxy(): Record<string, ProxyOptions> {
  return {
    "/admin": {
      target: "http://127.0.0.1:3766",
      changeOrigin: true,
      configure(proxy) {
        proxy.on("proxyReq", (outgoing, incoming) => {
          const host = incoming.headers.host;
          if (
            host &&
            /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) &&
            incoming.headers.origin === `http://${host}`
          )
            outgoing.setHeader("origin", "http://127.0.0.1:3766");
        });
      }
    }
  };
}
