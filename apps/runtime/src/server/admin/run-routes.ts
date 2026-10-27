import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import type { SqliteRuntimeContextStore, RunStatus } from "@synapse/runtime-core";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import type { RuntimeConfig } from "../../config/index.js";
import { sendJson } from "../http.js";

interface RunRouteOptions {
  readonly app: Nova;
  readonly getStore: () => SqliteRuntimeContextStore | undefined;
  readonly getConfig: () => RuntimeConfig;
  readonly shutdownSignal: AbortSignal;
}
class QueryError extends Error {}

/** 在现有 Admin 认证中间件之后注册只读运行检查与持久事件流 */
export function registerRunRoutes(options: RunRouteOptions): void {
  const route = (
    path: string,
    handler: (store: SqliteRuntimeContextStore, request: NovaRequest, response: NovaResponse) => void | Promise<void>
  ) => {
    options.app.get(path, async (request: NovaRequest, response: NovaResponse) => {
      const store = options.getStore();
      if (store === undefined) {
        sendJson(response, 503, { ok: false, error: "runtime_unavailable" });
        return;
      }
      response.setHeader("cache-control", "no-store");
      try {
        await handler(store, request, response);
      } catch (error) {
        if (!response.headersSent)
          sendJson(response, error instanceof QueryError ? 400 : 500, {
            ok: false,
            error: error instanceof QueryError ? "invalid_query" : "inspection_failed"
          });
        else response.socket.destroy();
      }
    });
  };
  route("/admin/runs", (store, request, response) => {
    const status = request.query.get("status") ?? undefined;
    if (
      status !== undefined &&
      !["accepted", "running", "succeeded", "failed", "blocked", "uncertain", "interrupted"].includes(status)
    )
      throw new QueryError();
    const since = dateQuery(request, "since");
    const until = dateQuery(request, "until");
    if (since && until && since > until) throw new QueryError();
    const page = store.runs.list({
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
  route("/admin/runs/:id", (store, request, response) => {
    const run = store.runs.get(request.params.id ?? "");
    sendJson(response, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: "run_not_found" });
  });
  route("/admin/runs/:id/events", (store, request, response) => {
    const run = store.runs.get(request.params.id ?? "");
    if (!run) {
      sendJson(response, 404, { ok: false, error: "run_not_found" });
      return;
    }
    const afterSeq = numberQuery(request, "afterSeq", 0);
    const events = store.runs.events(run.id, afterSeq, numberQuery(request, "limit", 100, 1, 200));
    const nextSeq = events.at(-1)?.seq ?? afterSeq;
    sendJson(response, 200, { ok: true, events, nextSeq, hasMore: nextSeq < run.lastSeq });
  });
  route("/admin/runs/:id/context", (store, request, response) => {
    const run = store.runs.get(request.params.id ?? "");
    if (!run) {
      sendJson(response, 404, { ok: false, error: "run_not_found" });
      return;
    }
    const snapshot = store.runs.latestEvent(run.id, "context_resolved");
    sendJson(response, 200, {
      ok: true,
      available: snapshot !== undefined,
      snapshot: snapshot?.data ?? null,
      eventId: snapshot?.id ?? null
    });
  });
  route("/admin/sessions", (store, request, response) => {
    const items = store.inspectSessions(
      numberQuery(request, "limit", 50, 1, 200),
      numberQuery(request, "before", Number.MAX_SAFE_INTEGER)
    );
    sendJson(response, 200, {
      ok: true,
      items,
      nextCursor: (items.at(-1) as { cursor?: number } | undefined)?.cursor ?? null
    });
  });
  for (const kind of ["transcript", "refs"] as const)
    route(`/admin/sessions/:id/${kind}`, async (store, request, response) => {
      const sessionId = request.params.id ?? "";
      if (!(await store.getSession(sessionId))) {
        sendJson(response, 404, { ok: false, error: "session_not_found" });
        return;
      }
      const limit = numberQuery(request, "limit", 50, 1, 200);
      const items =
        kind === "transcript"
          ? store.inspectTranscript(sessionId, limit, numberQuery(request, "before", Number.MAX_SAFE_INTEGER))
          : store.inspectRefs(sessionId, limit, request.query.get("after") ?? "");
      const last = items.at(-1) as { cursor?: number; name?: string } | undefined;
      sendJson(response, 200, {
        ok: true,
        items,
        nextCursor: (kind === "transcript" ? last?.cursor : last?.name) ?? null
      });
    });
  route("/admin/commits/:id", (store, request, response) => {
    const commit = store.contextGraph.getCommit(requiredQuery(request, "sessionId"), request.params.id ?? "");
    sendJson(
      response,
      commit ? 200 : 404,
      commit ? { ok: true, commit: store.inspectValue(commit) } : { ok: false, error: "commit_not_found" }
    );
  });
  const artifacts = () =>
    new ArtifactStore(join(options.getConfig().runtime.dataDir, "artifacts"), options.getConfig().container);
  route("/admin/artifacts", async (store, request, response) => {
    const sessionId = requiredQuery(request, "sessionId");
    if (!(await store.getSession(sessionId))) {
      sendJson(response, 404, { ok: false, error: "session_not_found" });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      ...artifacts().list(sessionId, request.query.get("after") ?? "", numberQuery(request, "limit", 50, 1, 200))
    });
  });
  for (const content of [false, true])
    route(`/admin/artifacts/:id${content ? "/content" : ""}`, (store, request, response) => {
      const sessionId = requiredQuery(request, "sessionId");
      const id = request.params.id ?? "";
      let artifact;
      try {
        artifact = content ? artifacts().read(sessionId, id) : artifacts().describe(sessionId, id);
      } catch {
        sendJson(response, 404, { ok: false, error: "artifact_unavailable" });
        return;
      }
      if (!content || !("data" in artifact)) {
        sendJson(response, 200, { ok: true, artifact: store.inspectValue(artifact) });
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
  route("/admin/run-events/stream", async (store, request, response) => {
    if (activeStreams >= 32) {
      sendJson(response, 429, { ok: false, error: "stream_limit" });
      return;
    }
    const supplied = request.getHeader("last-event-id") ?? request.query.get("after");
    let cursor =
      supplied === undefined || supplied === null
        ? store.runs.highWaterMark()
        : parseInteger(supplied, 0, Number.MAX_SAFE_INTEGER);
    if (cursor > store.runs.highWaterMark()) {
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
      await write(
        `event: snapshot\ndata: ${JSON.stringify({ protocolVersion: 1, cursor, highWaterMark: store.runs.highWaterMark(), runs: store.runs.list().items })}\n\n`
      );
      let heartbeat = Date.now();
      while (!controller.signal.aborted) {
        if (options.getStore() !== store) {
          await write("event: reset\ndata: {}\n\n");
          break;
        }
        const events = store.runs.stream(cursor, 200);
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
