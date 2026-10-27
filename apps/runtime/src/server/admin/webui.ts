import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { sendJson } from "../http.js";

/** 在 Admin 监听器托管构建产物，仅公开静态外壳，运行数据仍经过 Admin 认证 */
export function registerWebUi(app: Nova, directory = fileURLToPath(new URL("../../webui/", import.meta.url))): void {
  const root = resolve(directory);
  app.use(async (request: NovaRequest, response: NovaResponse, next: () => void) => {
    const path = request.pathname;
    if (request.method !== "GET" || (path !== "/" && !path.startsWith("/assets/"))) {
      next();
      return;
    }
    const asset = path === "/" ? "index.html" : path.slice(1);
    // Vite 产物名称只包含简单字符，拒绝编码路径、平台分隔符和源文件访问
    if (path !== "/" && !/^assets\/[a-zA-Z0-9_-]+\.(js|css|svg|png|woff2)$/.test(asset)) {
      sendJson(response, 404, { ok: false, error: "asset_not_found" });
      return;
    }
    try {
      const [rootPath, filePath] = await Promise.all([realpath(root), realpath(resolve(root, asset))]);
      if (!filePath.startsWith(rootPath + sep) || !(await stat(filePath)).isFile()) throw new Error("Invalid asset");
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2"
      };
      response
        .setHeader("content-type", types[extname(asset)] ?? "application/octet-stream")
        .setHeader("x-content-type-options", "nosniff")
        .setHeader("referrer-policy", "no-referrer")
        .setHeader("cache-control", path === "/" ? "no-cache" : "public, max-age=31536000, immutable")
        .setHeader(
          "content-security-policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        );
      response.send(await readFile(filePath));
    } catch {
      sendJson(response, 404, { ok: false, error: path === "/" ? "webui_not_built" : "asset_not_found" });
    }
  });
}
