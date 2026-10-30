import { defineConfig } from "vite";
import { runtimeProxy } from "./config/dev-proxy.js";

export default defineConfig({
  server: { proxy: runtimeProxy() },
  resolve: { dedupe: ["react", "react-dom"] },
  build: { sourcemap: false }
});
