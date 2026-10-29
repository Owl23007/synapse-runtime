import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/admin": {
        target: "http://127.0.0.1:3766",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            const host = incoming.headers.host;
            // 只转换本地预览自身的 Origin，避免开发代理替任意跨站请求绕过 Admin 来源校验
            if (
              host &&
              /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) &&
              incoming.headers.origin === `http://${host}`
            ) {
              outgoing.setHeader("origin", "http://127.0.0.1:3766");
            }
          });
        }
      }
    }
  },
  build: { sourcemap: false }
});
