import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const fixture = new URL("../../../tools/fixtures/webui/", import.meta.url);

/** 只在集成测试显式开启时挂载材质夹具，应用与生产产物不携带示例入口 */
export function testFixtures(): Plugin {
  return {
    name: "synapse-webui-test-fixtures",
    apply: "serve",
    resolveId(id) {
      if (id === "/@webui-test-fixture.tsx") return fileURLToPath(new URL("materials.tsx", fixture));
      if (id === "/@webui-test-fixture.css") return fileURLToPath(new URL("materials.css", fixture));
      return undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/design-system.html" || !["GET", "HEAD"].includes(request.method ?? ""))
          return next();
        const html =
          '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebUI 材质测试</title></head><body><div id="root"></div><script type="module" src="/@webui-test-fixture.tsx"></script></body></html>';
        const render = async () => {
          try {
            const result = await server.transformIndexHtml("/design-system.html", html);
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(request.method === "HEAD" ? undefined : result);
          } catch {
            response.statusCode = 500;
            response.end("测试夹具加载失败");
          }
        };
        void render();
      });
    }
  };
}
