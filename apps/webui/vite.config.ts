import { defineConfig } from "vite";

export default defineConfig({
  server: { proxy: { "/admin": { target: "http://127.0.0.1:3766", changeOrigin: true } } },
  build: { sourcemap: false }
});
