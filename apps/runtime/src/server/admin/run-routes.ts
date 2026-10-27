import { setTimeout as delay } from "node:timers/promises";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import type { RunStatus } from "@synapse/runtime-core";
import { InspectionQueryError, type RuntimeInspection } from "@synapse/runtime-core/inspection";
import { sendJson } from "../http.js";

interface RunRouteOptions {
  readonly app: Nova;
  readonly getInspection: () => RuntimeInspection | undefined;
  readonly shutdownSignal: AbortSignal;
}
class QueryError extends InspectionQueryError {}

/** 在现有 Admin 认证中间件之后注册只读运行检查与持久事件流 */
export function registerRunRoutes(options: RunRouteOptions): void {
  const route = (
    path: string,
    handler: (inspection: RuntimeInspection, request: NovaRequest, response: NovaResponse) => void | Promise<void>
  ) => {
    options.app.get(path, async (request: NovaRequest, response: NovaResponse) => {
      const inspection = options.getInspection();
      if (inspection === undefined) {
        sendJson(response, 503, { ok: false, error: "runtime_unavailable" });
        return;
      }
      response.setHeader("cache-control", "no-store");
      try {
        await handler(inspection, request, response);
      } catch (error) {
        if (!response.headersSent)
          sendJson(response, error instanceof InspectionQueryError ? 400 : 500, {
            ok: false,
            error: error instanceof InspectionQueryError ? "invalid_query" : "inspection_failed"
          });
        else response.socket.destroy();
      }
    });
  };
  route("/admin/runs", (inspection, request, response) => {
    const status = request.query.get("status") ?? undefined;
    const since = dateQuery(request, "since");
    const until = dateQuery(request, "until");
    const page = inspection.listRuns({
      limit: numberQuery(request, "limit", 50, 1, 200),
      before: numberQuery(request, "before", Number.MAX_SAFE_INTEGER),
      ...(status === undefined ? {} : { status: status as RunStatus }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(request.query.has("sessionId") ? { sessionId: request.query.get("sessionId")! } : {}),
      ...(request.query.has("channelId") ? { channelId: request.query.get("channelId")! } : {})
    });
    sendJson(response, 200, { ok: true, protocolVersion: 1, ...page });
  });
  route("/admin/runs/:id", (inspection, request, response) => {
    const run = inspection.getRun(request.params.id ?? "");
    sendJson(response, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: "run_not_found" });
  });
  route("/admin/runs/:id/events", (inspection, request, response) => {
    const id = request.params.id ?? "";
    if (!inspection.getRun(id)) {
      sendJson(response, 404, { ok: false, error: "run_not_found" });
      return;
    }
    const page = inspection.getRunEvents(
      id,
      numberQuery(request, "afterSeq", 0),
      numberQuery(request, "limit", 100, 1, 200)
    );
    sendJson(response, 200, { ok: true, ...page });
  });
  route("/admin/runs/:id/context", (inspection, request, response) => {
    const snapshot = inspection.getRunContext(request.params.id ?? "");
    sendJson(
      response,
      snapshot ? 200 : 404,
      snapshot ? { ok: true, ...snapshot } : { ok: false, error: "run_not_found" }
    );
  });
  route("/admin/sessions", (inspection, request, response) => {
    sendJson(response, 200, {
      ok: true,
      ...inspection.listSessions(
        numberQuery(request, "limit", 50, 1, 200),
        numberQuery(request, "before", Number.MAX_SAFE_INTEGER)
      )
    });
  });
  for (const kind of ["transcript", "refs"] as const)
    route(`/admin/sessions/:id/${kind}`, async (inspection, request, response) => {
      const sessionId = request.params.id ?? "";
      if (!(await inspection.getSession(sessionId))) {
        sendJson(response, 404, { ok: false, error: "session_not_found" });
        return;
      }
      const limit = numberQuery(request, "limit", 50, 1, 200);
      const page =
        kind === "transcript"
          ? await inspection.getTranscript(sessionId, limit, numberQuery(request, "before", Number.MAX_SAFE_INTEGER))
          : await inspection.getRefs(sessionId, limit, request.query.get("after") ?? "");
      sendJson(response, 200, { ok: true, ...page });
    });
  route("/admin/commits/:id", (inspection, request, response) => {
    const commit = inspection.getCommit(requiredQuery(request, "sessionId"), request.params.id ?? "");
    sendJson(response, commit ? 200 : 404, commit ? { ok: true, commit } : { ok: false, error: "commit_not_found" });
  });
  route("/admin/artifacts", async (inspection, request, response) => {
    const sessionId = requiredQuery(request, "sessionId");
    if (!(await inspection.getSession(sessionId))) {
      sendJson(response, 404, { ok: false, error: "session_not_found" });
      return;
    }
    const page = await inspection.listArtifacts(
      sessionId,
      request.query.get("after") ?? "",
      numberQuery(request, "limit", 50, 1, 200)
    );
    sendJson(response, 200, { ok: true, ...page });
  });
  route("/admin/artifacts/:id", (inspection, request, response) => {
    const artifact = inspection.getArtifact(requiredQuery(request, "sessionId"), request.params.id ?? "");
    sendJson(
      response,
      artifact === undefined ? 404 : 200,
      artifact === undefined ? { ok: false, error: "artifact_unavailable" } : { ok: true, artifact }
    );
  });
  route("/admin/artifacts/:id/content", (inspection, request, response) => {
    const artifact = inspection.readArtifact(requiredQuery(request, "sessionId"), request.params.id ?? "");
    if (artifact === undefined) {
      sendJson(response, 404, { ok: false, error: "artifact_unavailable" });
      return;
    }
    response
      .setHeader("content-type", "application/octet-stream")
      .setHeader("x-content-type-options", "nosniff")
      .setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`)
      .setHeader("content-length", String(artifact.size));
    response.send(Buffer.from(artifact.data));
  });

  let activeStreams = 0;
  route("/admin/run-events/stream", async (inspection, request, response) => {
    if (activeStreams >= 32) {
      sendJson(response, 429, { ok: false, error: "stream_limit" });
      return;
    }
    const supplied = request.getHeader("last-event-id") ?? request.query.get("after");
    const snapshot = inspection.streamSnapshot(
      supplied === undefined || supplied === null ? undefined : parseInteger(supplied, 0, Number.MAX_SAFE_INTEGER)
    );
    let cursor = snapshot.cursor;
    if (cursor > snapshot.highWaterMark) {
      sendJson(response, 409, { ok: false, error: "cursor_reset_required" });
      return;
    }
    activeStreams++;
    const controller = new AbortController();
    const close = () => {
      controller.abort();
      response.socket.destroy();
    };
    options.shutdownSignal.addEventListener("abort", close, { once: true });
    response.socket.once("close", close);
    const write = async (chunk: string) => {
      const timeout = setTimeout(close, 5_000);
      try {
        await response.write(chunk);
      } finally {
        clearTimeout(timeout);
      }
    };
    try {
      response
        .setHeader("content-type", "text/event-stream; charset=utf-8")
        .setHeader("cache-control", "no-cache, no-transform")
        .setHeader("x-accel-buffering", "no");
      await response.flushHeaders();
      if (options.shutdownSignal.aborted) close();
      // 快照与游标在同步 SQLite 调用内读取；之后的写入通过持久游标补读，不存在订阅间隙
      await write(`event: snapshot\ndata: ${JSON.stringify({ protocolVersion: 1, ...snapshot })}\n\n`);
      let heartbeat = Date.now();
      while (!controller.signal.aborted) {
        if (options.getInspection() !== inspection) {
          await write("event: reset\ndata: {}\n\n");
          break;
        }
        const events = inspection.streamEvents(cursor, 200);
        for (const event of events) {
          // 每条写入等待背压，不积累内存队列
          // oxlint-disable-next-line no-await-in-loop
          await write(`id: ${event.cursor}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.cursor;
        }
        if (Date.now() - heartbeat > 15_000) {
          await write(": heartbeat\n\n");
          heartbeat = Date.now();
        }
        // oxlint-disable-next-line no-await-in-loop
        await delay(events.length === 200 ? 1 : 250, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      activeStreams--;
      options.shutdownSignal.removeEventListener("abort", close);
      response.socket.removeListener("close", close);
      close();
    }
  });
}

function requiredQuery(request: NovaRequest, key: string): string {
  const value = request.query.get(key);
  if (!value || value.length > 2048) throw new QueryError();
  return value;
}
function numberQuery(
  request: NovaRequest,
  key: string,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  const value = request.query.get(key);
  return value === null ? fallback : parseInteger(value, min, max);
}
function parseInteger(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new QueryError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new QueryError();
  return parsed;
}
function dateQuery(request: NovaRequest, key: string): string | undefined {
  const value = request.query.get(key);
  if (value === null) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new QueryError();
  return new Date(value).toISOString();
}
