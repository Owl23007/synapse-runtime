import { ResourceOperationError } from "@synapse/runtime-core/assets";
import type { CapabilityService } from "@synapse/runtime-core/capabilities";
import { CatalogError } from "@synapse/runtime-resources";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { z } from "zod";
import { readJsonBody, sendJson } from "../http.js";

/** 能力管理只依赖安装与连接的领域接口，HTTP 不操作数据库或进程 */
export interface CapabilityRouteDeps {
  readonly app: Nova;
  readonly getCapabilities: () => CapabilityService | undefined;
  readonly connections: () => readonly unknown[];
  readonly connect: (installId: string, refresh: boolean) => Promise<unknown>;
  readonly dependencies: (runId: string) => unknown;
}

/** 在统一 Admin 认证后注册能力发现、安装、启停与回滚操作 */
export function registerCapabilityRoutes(deps: CapabilityRouteDeps): void {
  const route = (
    method: "get" | "post" | "put",
    path: string,
    handler: (service: CapabilityService, request: NovaRequest) => unknown | Promise<unknown>
  ) =>
    deps.app[method](path, async (request: NovaRequest, response: NovaResponse) => {
      response.setHeader("cache-control", "no-store");
      const service = deps.getCapabilities();
      if (!service) {
        sendJson(response, 503, { ok: false, error: "runtime_unavailable" });
        return;
      }
      try {
        sendJson(response, 200, { ok: true, ...((await handler(service, request)) as object) });
      } catch (error) {
        if (error instanceof CatalogError && error.retryAfter)
          response.setHeader("retry-after", String(error.retryAfter));
        sendJson(
          response,
          error instanceof ResourceOperationError || error instanceof CatalogError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 502,
          {
            ok: false,
            error:
              error instanceof ResourceOperationError || error instanceof CatalogError
                ? error.code
                : error instanceof z.ZodError
                  ? "invalid_request"
                  : "capability_operation_failed"
          }
        );
      }
    });
  route("get", "/admin/capabilities", (service, request) => ({
    items: service.store.list(request.query.get("kind") ?? undefined, request.query.get("q") ?? "").map(publicInstall)
  }));
  route("get", "/admin/capabilities/updates", (service) => ({ items: service.updates() }));
  route("get", "/admin/catalogs", (service) => ({ items: service.catalogs.map((catalog) => ({ id: catalog.id })) }));
  route("get", "/admin/catalogs/:provider/search", (service, request) =>
    service
      .catalog(request.params.provider ?? "")
      .search({ query: request.query.get("q") ?? "", cursor: request.query.get("cursor") ?? undefined })
  );
  route("get", "/admin/catalogs/:provider/items/:id/versions", (service, request) =>
    service.catalog(request.params.provider ?? "").versions(request.params.id ?? "")
  );
  route("get", "/admin/catalogs/:provider/items/:id", async (service, request) => ({
    item: await service.catalog(request.params.provider ?? "").get(request.params.id ?? "")
  }));
  route("post", "/admin/capabilities/install", async (service, request) => ({
    installation: publicInstall(await service.install(readJsonBody(request), "runtime-admin"))
  }));
  route("get", "/admin/capabilities/:id", (service, request) => {
    const installation = service.store.get(request.params.id ?? "");
    return { installation: publicInstall(installation) };
  });
  route("get", "/admin/capabilities/:id/resource", (service, request) => ({
    resource: service
      .loader(request.params.id ?? "")
      .readResource(request.query.get("path") ?? "SKILL.md", Number(request.query.get("offset") ?? 0), 16000)
  }));
  route("post", "/admin/capabilities/:id/check-updates", async (service, request) => ({
    update: await service.checkUpdates(request.params.id ?? "")
  }));
  route("get", "/admin/workspaces/:id/capabilities", (service, request) => ({
    items: service.store.bindings(request.params.id ?? "")
  }));
  route("put", "/admin/workspaces/:id/capabilities/:packageKey", async (service, request) => {
    const value: unknown = readJsonBody(request);
    const binding = service.bind(request.params.id ?? "", request.params.packageKey ?? "", value, "runtime-admin");
    // 连接失败保留已审核的授权与可见错误，工具调用仍失败关闭
    if (binding.enabled && service.store.get(binding.installId).kind === "mcp") {
      try {
        await deps.connect(binding.installId, false);
      } catch {
        /* Connections 页面显示具体连接状态 */
      }
    }
    return { binding };
  });
  route("get", "/admin/mcp/connections", () => ({ items: deps.connections() }));
  route("get", "/admin/mcp/connections/:id/status", (_service, request) => {
    const item = deps
      .connections()
      .find(
        (item) =>
          (item as { installId?: string }).installId === request.params.id ||
          (item as { id?: string }).id === request.params.id
      );
    if (!item) throw new ResourceOperationError(404, "mcp_connection_not_found");
    return { connection: item };
  });
  route("post", "/admin/mcp/connections/:id/connect", async (_service, request) => ({
    connection: await deps.connect(request.params.id ?? "", true)
  }));
  route("get", "/admin/runs/:id/dependencies", (_service, request) => ({
    snapshot: deps.dependencies(request.params.id ?? "")
  }));
}

function publicInstall(installation: import("@synapse/runtime-core/capabilities").CapabilityInstall) {
  const { installPath: _installPath, ...value } = installation;
  return value;
}
