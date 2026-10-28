import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { WorkspaceOperationError, type RuntimeWorkspace } from "@synapse/runtime-core/workspace";
import { readJsonBody, sendJson } from "../http.js";

/** 注册认证后的工作台传输接口，业务操作由当前运行组合提供 */
export function registerWorkspaceRoutes(app: Nova, getWorkspace: () => RuntimeWorkspace | undefined): void {
  const route = (
    method: "get" | "post",
    path: string,
    handler: (workspace: RuntimeWorkspace, request: NovaRequest) => Promise<unknown>
  ) => {
    app[method](path, async (request: NovaRequest, response: NovaResponse) => {
      const workspace = getWorkspace();
      response.setHeader("cache-control", "no-store");
      if (!workspace) {
        sendJson(response, 503, { ok: false, error: "runtime_unavailable" });
        return;
      }
      try {
        sendJson(response, 200, { ok: true, ...((await handler(workspace, request)) as object) });
      } catch (error) {
        sendJson(response, error instanceof WorkspaceOperationError ? error.status : 409, {
          ok: false,
          error: error instanceof Error ? error.message : "操作失败"
        });
      }
    });
  };
  route("post", "/admin/sessions", (workspace, request) => workspace.createSession(readJsonBody(request)));
  route("post", "/admin/runs", (workspace, request) => workspace.submitRun(readJsonBody(request)));
  route("get", "/admin/sessions/:id/workspace", (workspace, request) =>
    workspace.getWorkspace(
      request.params.id ?? "",
      request.query.get("lineId") ?? undefined,
      request.query.get("before") ?? undefined
    )
  );
  route("post", "/admin/sessions/:id/fork", (workspace, request) =>
    workspace.fork(request.params.id ?? "", readJsonBody(request))
  );
  route("post", "/admin/sessions/:id/merge", (workspace, request) =>
    workspace.merge(request.params.id ?? "", readJsonBody(request))
  );
}
