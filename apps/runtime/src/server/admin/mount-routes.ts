import { ResourceOperationError, type ReadonlyMounts } from "@synapse/runtime-core/assets";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { sendJson } from "../http.js";

/** 配置的 Mount URL 仅提供只读内容，私有挂载只允许受控 Agent 工具访问 */
export function registerMountRoutes(
  app: Nova,
  getMounts: () => ReadonlyMounts | undefined,
  prefixes: readonly string[],
  authorize: (request: NovaRequest, response: NovaResponse) => boolean
): void {
  for (const prefix of prefixes) {
    app.get(prefix, async (request: NovaRequest, response: NovaResponse) => {
      const mounts = getMounts();
      const mount = mounts?.mounts.find((mount) => mount.urlPrefix === prefix);
      if (!mount || mount.access === "private") {
        sendJson(response, 404, { ok: false, error: "mount_not_found" });
        return;
      }
      if (mount.access !== "public" && !authorize(request, response)) return;
      try {
        const path = request.query.get("path") ?? "";
        response
          .setHeader("cache-control", "no-store")
          .setHeader("x-content-type-options", "nosniff")
          .setHeader("content-security-policy", "default-src 'none'; sandbox");
        if (!path || request.query.has("list")) {
          sendJson(response, 200, { ok: true, ...(await mounts!.entries(mount.id, path)) });
          return;
        }
        const { bytes, mime, name } = await mounts!.read(mount.id, path);
        response
          .setHeader("content-type", mime)
          .setHeader("content-length", String(bytes.length))
          .setHeader(
            "content-disposition",
            `${mime === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`
          );
        await response.write(bytes);
        response.end();
      } catch (error) {
        if (!response.headersSent)
          sendJson(response, error instanceof ResourceOperationError ? error.status : 500, {
            ok: false,
            error: error instanceof ResourceOperationError ? error.code : "mount_read_failed"
          });
      }
    });
    for (const method of ["post", "put", "patch", "delete"] as const)
      app[method](prefix, (_request: NovaRequest, response: NovaResponse) => {
        response.setHeader("allow", "GET");
        sendJson(response, 405, { ok: false, error: "mount_readonly" });
      });
  }
}
