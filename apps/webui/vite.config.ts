import { defineConfig } from "vite";
import { runtimeProxy } from "./config/dev-proxy.js";
import { testFixtures } from "./config/test-fixtures.js";

export default defineConfig({
  plugins: process.env.SYNAPSE_WEBUI_TEST_FIXTURES === "1" ? [testFixtures()] : [],
  server: { proxy: runtimeProxy() },
  resolve: { dedupe: ["react", "react-dom"] },
  build: { sourcemap: false }
});
