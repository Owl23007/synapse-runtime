import {
  ResourceOperationError,
  type AssetService,
  type AssetQuery,
  type ReadonlyMounts
} from "@synapse/runtime-core/assets";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { z } from "zod";
import { readJsonBody, sendJson } from "../http.js";

/** 资源路由依赖领域门面，二进制入口与 JSON 入口分离 */
export interface AssetRouteDeps {
  readonly app: Nova;
  readonly getAssets: () => AssetService | undefined;
  readonly listWorkspaces: () => readonly { id: string; name: string; type: string }[];
  readonly sessionWorkspace: (sessionId: string) => string | undefined;
  readonly syncFiles: (channelId: string, groupId: string, folderId?: string) => Promise<unknown>;
  readonly getMounts: () => ReadonlyMounts | undefined;
}

/** 在统一 Admin 认证后注册文件元数据、上传、预览及生命周期操作 */
export function registerAssetRoutes(deps: AssetRouteDeps): void {
  const route = (
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    handler: (assets: AssetService, request: NovaRequest, response: NovaResponse) => unknown | Promise<unknown>
  ) => {
    deps.app[method](path, async (request: NovaRequest, response: NovaResponse) => {
      response.setHeader("cache-control", "no-store");
      const assets = deps.getAssets();
      if (!assets) {
        sendJson(response, 503, { ok: false, error: "files_disabled" });
        return;
      }
      try {
        const result = await handler(assets, request, response);
        if (result !== undefined) sendJson(response, 200, { ok: true, ...(result as object) });
      } catch (error) {
        if (!response.headersSent)
          sendJson(
            response,
            error instanceof ResourceOperationError ? error.status : error instanceof z.ZodError ? 400 : 500,
            {
              ok: false,
              error:
                error instanceof ResourceOperationError
                  ? error.code
                  : error instanceof z.ZodError
                    ? "invalid_request"
                    : "resource_operation_failed"
            }
          );
      }
    });
  };
  deps.app.get("/admin/workspaces", (_request: NovaRequest, response: NovaResponse) =>
    sendJson(response, 200, { ok: true, items: deps.listWorkspaces() })
  );
  route("get", "/admin/workspaces/:id/mounts", (assets, request) => {
    assets.index.requireWorkspace(request.params.id ?? "");
    return { items: deps.getMounts()?.list() ?? [] };
  });
  route("get", "/admin/mounts/:id/entries", async (_assets, request) => {
    const mounts = deps.getMounts();
    if (!mounts) throw new ResourceOperationError(404, "mount_not_found");
    return mounts.entries(request.params.id ?? "", request.query.get("path") ?? "");
  });
  route("post", "/admin/workspaces/:id/mounts/:mountId/materialize", async (assets, request) => {
    const { path } = z
      .object({ path: z.string().min(1).max(500) })
      .strict()
      .parse(readJsonBody(request));
    const mounts = deps.getMounts();
    if (!mounts) throw new ResourceOperationError(404, "mount_not_found");
    assets.index.requireWorkspace(request.params.id ?? "");
    return mounts.materialize(assets, request.params.id ?? "", request.params.mountId ?? "", path);
  });
  route("get", "/admin/sessions/:id/resource-workspace", (_assets, request) => {
    const workspaceId = deps.sessionWorkspace(request.params.id ?? "");
    if (!workspaceId) throw new ResourceOperationError(404, "workspace_not_found");
    return { workspaceId };
  });
  route("get", "/admin/workspaces/:id/assets", (assets, request) =>
    assets.index.list(request.params.id ?? "", {
      ...(request.query.has("q") ? { query: request.query.get("q")! } : {}),
      ...(request.query.has("cursor") ? { cursor: request.query.get("cursor")! } : {}),
      ...(request.query.has("source")
        ? {
            source: z.enum(["qq_group", "qq_private", "native", "artifact", "mount"]).parse(request.query.get("source"))
          }
        : {}),
      ...(request.query.has("limit") ? { limit: Number(request.query.get("limit")) } : {})
    } satisfies AssetQuery)
  );
  route("get", "/admin/assets/:id", (assets, request) =>
    assets.detail(request.params.id ?? "", request.query.get("workspaceId") ?? undefined)
  );
  const uploadSchema = z
    .object({
      name: z.string().min(1).max(255),
      size: z.number().int().nonnegative(),
      mime: z.string().max(150).optional(),
      idempotencyKey: z.string().min(1).max(200)
    })
    .strict();
  route("post", "/admin/workspaces/:id/assets/uploads", (assets, request) =>
    assets.beginUpload(request.params.id ?? "", uploadSchema.parse(readJsonBody(request)))
  );
  route("put", "/admin/assets/uploads/:uploadId/content", (assets, request) => {
    if (request.getHeader("content-type")?.split(";")[0] !== "application/octet-stream")
      throw new ResourceOperationError(415, "raw_upload_required");
    return assets.upload(request.params.uploadId ?? "", request.body, AbortSignal.timeout(60_000));
  });
  route("post", "/admin/assets/:id/materialize", async (assets, request) => {
    const id = request.params.id ?? "";
    return { version: await assets.materialize(assets.locate(id, request.query.get("workspaceId") ?? undefined), id) };
  });
  route("patch", "/admin/assets/:id", (assets, request) => {
    const id = request.params.id ?? "";
    const { name } = z.object({ name: z.string() }).strict().parse(readJsonBody(request));
    return { asset: assets.index.rename(assets.locate(id), id, name) };
  });
  route("delete", "/admin/assets/:id", (assets, request) => {
    const id = request.params.id ?? "";
    assets.index.remove(assets.locate(id), id);
    return { deleted: true };
  });
  route("post", "/admin/assets/:id/versions", (assets, request) => {
    const id = request.params.id ?? "";
    return assets.beginUpload(assets.locate(id), { ...uploadSchema.parse(readJsonBody(request)), assetId: id });
  });
  route("post", "/admin/files/sync", (_assets, request) => {
    const body = z
      .object({ channelId: z.string().min(1), groupId: z.string().min(1), folderId: z.string().optional() })
      .strict()
      .parse(readJsonBody(request));
    return deps.syncFiles(body.channelId, body.groupId, body.folderId);
  });
  route("get", "/admin/assets/:id/content", async (assets, request, response) => {
    const id = request.params.id ?? "";
    const workspaceId = assets.locate(id, request.query.get("workspaceId") ?? undefined);
    // 显式历史版本允许软删除后查看，管理员仍需通过当前已鉴权资源入口
    const versionId = request.query.get("versionId") ?? undefined;
    const version = versionId
      ? assets.index.version(workspaceId, id, versionId, true)
      : await assets.materialize(workspaceId, id);
    const bytes = await assets.blobs.read(version.blobKey, version.sizeBytes);
    const preview = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)/.test(version.detectedMime);
    response
      .setHeader("content-type", version.detectedMime)
      .setHeader("x-content-type-options", "nosniff")
      .setHeader("content-security-policy", "default-src 'none'; sandbox")
      .setHeader("accept-ranges", "bytes");
    response.setHeader(
      "content-disposition",
      `${preview && !request.query.has("download") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(assets.index.get(workspaceId, id, true).displayName)}`
    );
    const range = request.getHeader("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(match?.[1]);
      const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= bytes.length) {
        response.status(416).setHeader("content-range", `bytes */${bytes.length}`).end();
        return;
      }
      response
        .status(206)
        .setHeader("content-range", `bytes ${start}-${end}/${bytes.length}`)
        .setHeader("content-length", String(end - start + 1));
      await response.write(bytes.subarray(start, end + 1));
      response.end();
      return;
    }
    response.setHeader("content-length", String(bytes.length));
    await response.write(bytes);
    response.end();
  });
}
