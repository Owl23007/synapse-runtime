import { z } from "zod";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import type { ExecutionStore } from "@synapse/runtime-core/execution";
import { readJsonBody, sendJson } from "../http.js";

/** 管理员控制持久执行，历史清理必须通过显式确认的独立入口 */
export function registerExecutionRoutes(
  app: Nova,
  getStore: () => ExecutionStore | undefined,
  localize: (key: string) => string
): void {
  const route = (
    method: "get" | "post",
    path: string,
    handle: (store: ExecutionStore, request: NovaRequest) => unknown,
    field = "result"
  ) => {
    app[method](path, (request: NovaRequest, response: NovaResponse) => {
      response.setHeader("cache-control", "no-store");
      const store = getStore();
      if (!store) {
        sendJson(response, 503, { ok: false, error: "runtime_unavailable" });
        return;
      }
      try {
        const value = handle(store, request);
        if (value === undefined)
          sendJson(response, 404, { ok: false, error: "task_not_found", message: localize("admin.task_not_found") });
        else sendJson(response, 200, { ok: true, [field]: store.inspect(value) });
      } catch (error) {
        sendJson(response, 409, {
          ok: false,
          error: store.inspect(error instanceof Error ? error.message : "Execution operation failed")
        });
      }
    });
  };
  route(
    "get",
    "/admin/tasks",
    (store, request) => {
      for (const key of request.query.keys()) if (key !== "workspaceId") throw new Error("Unsupported task filter");
      const workspaceId = request.query.get("workspaceId") ?? undefined;
      if (workspaceId !== undefined && !workspaceId.trim()) throw new Error("Invalid workspace filter");
      return store.inspectTasks(workspaceId);
    },
    "tasks"
  );
  route("get", "/admin/tasks/:id", (store, request) => store.inspectTask(request.params.id ?? ""), "task");
  route(
    "post",
    "/admin/tasks/:id/cancel",
    (store, request) => {
      const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(readJsonBody(request));
      if (!store.inspectTask(request.params.id ?? "")) return undefined;
      return store.controlTask(request.params.id ?? "", body.expectedRevision, "cancelled");
    },
    "task"
  );
  route(
    "post",
    "/admin/tasks/:id/status",
    (store, request) => {
      const body = z
        .object({ expectedRevision: z.number().int().positive(), status: z.enum(["open", "paused", "cancelled"]) })
        .strict()
        .parse(readJsonBody(request));
      if (!store.inspectTask(request.params.id ?? "")) return undefined;
      return store.controlTask(request.params.id ?? "", body.expectedRevision, body.status);
    },
    "task"
  );
  route("get", "/admin/execution/retention-preview", (store) => store.collectionPreview());
  route("post", "/admin/execution/retention-apply", (store, request) => {
    const body = z
      .object({ confirmation: z.literal("delete-expired-derived-execution-records") })
      .strict()
      .parse(readJsonBody(request));
    const before = store.collectionPreview();
    store.collect(body.confirmation);
    return { before, remaining: store.collectionPreview() };
  });
  route("get", "/admin/execution/runs/:id", (store, request) => {
    const runId = request.params.id ?? "";
    return { intent: store.forRun(runId), outcome: store.result(runId), inputs: store.inputs(runId, true) };
  });
  route("post", "/admin/execution/runs/:id/inbox", (store, request) => {
    const body = z
      .object({ key: z.string().min(1).max(300), content: z.string().min(1).max(16000) })
      .strict()
      .parse(readJsonBody(request));
    store.enqueueInput(request.params.id ?? "", body.key, body.content);
    return { accepted: true };
  });
  route("post", "/admin/execution/runs/:id/retry-delivery", (store, request) => {
    const body = z
      .object({ key: z.string().min(1).max(300) })
      .strict()
      .parse(readJsonBody(request));
    return store.retryDelivery(request.params.id ?? "", body.key);
  });
  route("post", "/admin/execution/grants/:id/revoke", (store, request) => {
    store.revokeGrant(request.params.id ?? "");
    return { revoked: true };
  });
  route("get", "/admin/execution/grants/:id/tasks", (store, request) => {
    const grant = store.getGrant(request.params.id ?? "");
    if (!grant) throw new Error("Grant not found");
    return store.listTasks(grant);
  });
  route("get", "/admin/execution/grants/:id/schedules", (store, request) => {
    const grant = store.getGrant(request.params.id ?? "");
    if (!grant) throw new Error("Grant not found");
    return store.listSchedules(grant);
  });
  route("post", "/admin/execution/schedules/:id/status", (store, request) => {
    const body = z
      .object({ expectedRevision: z.number().int().positive(), status: z.enum(["active", "paused", "cancelled"]) })
      .strict()
      .parse(readJsonBody(request));
    const schedule = store.schedule(request.params.id ?? "");
    const grant = schedule && store.getGrant(schedule.grantId);
    if (!schedule || !grant) throw new Error("Schedule not found");
    return store.updateSchedule(grant, schedule.id, body.expectedRevision, { status: body.status });
  });
}
