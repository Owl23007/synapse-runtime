import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redactTrace } from "./redact.js";
import type {
  AcceptRunInput,
  AppendRunEventInput,
  ListRunsInput,
  RunEvent,
  RunPage,
  RunStatus,
  RunTrace,
  RunTraceStore
} from "./types.js";

interface RunRow {
  readonly ordinal: number;
  readonly record: string;
}
interface EventRow {
  readonly cursor: number;
  readonly record: string;
  readonly request: string;
}
const ACTIVE = new Set<RunStatus>(["accepted", "running"]);
const STATES = new Set<RunStatus>([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "uncertain",
  "interrupted"
]);
const TERMINAL_EVENTS: Partial<Record<AppendRunEventInput["type"], RunStatus>> = {
  run_succeeded: "succeeded",
  run_failed: "failed",
  run_blocked: "blocked",
  run_uncertain: "uncertain",
  run_interrupted: "interrupted"
};

/** 与上下文共享 SQLite 连接的追踪仓储，扩展迁移独立记账以保留旧库迁移契约 */
export class SqliteRunTraceStore implements RunTraceStore {
  /** 初始化可独立回滚的追踪表，拒绝尚不认识的版本 */
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: readonly string[] = []
  ) {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS run_trace_migrations (version INTEGER PRIMARY KEY)");
      const versions = db.prepare("SELECT version FROM run_trace_migrations").all() as { version: number }[];
      if (versions.some(({ version }) => version !== 1)) throw new Error("Unsupported run trace schema version");
      if (versions.length !== 0) return;
      db.exec(`
        CREATE TABLE run_traces (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          source_event_id TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          status TEXT NOT NULL, started_at TEXT NOT NULL, record TEXT NOT NULL,
          UNIQUE(session_id, channel_id, source_event_id)
        );
        CREATE INDEX run_traces_status ON run_traces(status, ordinal);
        CREATE INDEX run_traces_session ON run_traces(session_id, ordinal);
        CREATE INDEX run_traces_channel ON run_traces(channel_id, ordinal);
        CREATE INDEX run_traces_time ON run_traces(started_at, ordinal);
        CREATE TABLE run_events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run_traces(id),
          seq INTEGER NOT NULL, event_key TEXT NOT NULL, record TEXT NOT NULL, request TEXT NOT NULL,
          UNIQUE(run_id, seq), UNIQUE(run_id, event_key)
        );
        INSERT INTO run_trace_migrations VALUES (1);
      `);
    }).immediate();
  }

  /** 同一规范化事件仅创建一次运行，接受事件与运行行原子写入 */
  accept(input: AcceptRunInput): RunTrace {
    for (const field of [input.sourceEventId, input.sessionId, input.channelId]) validateId(field);
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare("SELECT record FROM run_traces WHERE session_id = ? AND channel_id = ? AND source_event_id = ?")
          .get(input.sessionId, input.channelId, input.sourceEventId) as RunRow | undefined;
        if (row) {
          const previous = JSON.parse(row.record) as RunTrace;
          if (previous.lineId !== input.lineId || previous.branchId !== input.branchId)
            throw new Error("Run identity conflict");
          return previous;
        }
        const id = `run-${createHash("sha256")
          .update(JSON.stringify([input.sessionId, input.channelId, input.sourceEventId]))
          .digest("hex")}`;
        const now = new Date().toISOString();
        const run: RunTrace = {
          ...input,
          id,
          protocolVersion: 1,
          summary: String(redactTrace(input.summary, this.secrets)).slice(0, 500),
          status: "accepted",
          phase: "accepted",
          startedAt: now,
          updatedAt: now,
          lastSeq: 0
        };
        this.db
          .prepare(
            "INSERT INTO run_traces(id, source_event_id, session_id, channel_id, status, started_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(id, input.sourceEventId, input.sessionId, input.channelId, run.status, now, JSON.stringify(run));
        this.append(id, { key: "accepted", type: "run_accepted" });
        return this.get(id)!;
      })
      .immediate();
  }

  /** 对相同幂等键拒绝不同载荷，事件与状态投影同时成功或回滚 */
  append(runId: string, input: AppendRunEventInput): RunEvent {
    validateId(input.key);
    if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0))
      throw new Error("Invalid event duration");
    const safe = {
      ...input,
      data: redactTrace(input.data ?? null, this.secrets),
      ...(input.error === undefined ? {} : { error: redactTrace(input.error, this.secrets) })
    } as AppendRunEventInput;
    const request = JSON.stringify(redactTrace(safe, this.secrets));
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare("SELECT cursor, record, request FROM run_events WHERE run_id = ? AND event_key = ?")
          .get(runId, input.key) as EventRow | undefined;
        if (prior) {
          if (prior.request !== request) throw new Error("Run event idempotency conflict");
          return eventFromRow(prior);
        }
        const run = this.get(runId);
        if (!run) throw new Error("Run not found");
        const status = input.status ?? run.status;
        validateTransition(run.status, status, input.type);
        const now = new Date().toISOString();
        const event = {
          id: randomUUID(),
          protocolVersion: 1 as const,
          runId,
          seq: run.lastSeq + 1,
          type: input.type,
          occurredAt: now,
          data: safe.data,
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
        };
        const result = this.db
          .prepare("INSERT INTO run_events(run_id, seq, event_key, record, request) VALUES (?, ?, ?, ?, ?)")
          .run(runId, event.seq, input.key, JSON.stringify(event), request);
        const next: RunTrace = {
          ...run,
          status,
          phase: input.phase ?? run.phase,
          updatedAt: now,
          lastSeq: event.seq,
          ...(!ACTIVE.has(status) ? { finishedAt: now } : {}),
          ...(safe.error === undefined ? {} : { error: safe.error })
        };
        if (status === "running") {
          delete (next as { finishedAt?: string }).finishedAt;
          delete (next as { error?: unknown }).error;
        }
        this.db
          .prepare("UPDATE run_traces SET status = ?, record = ? WHERE id = ?")
          .run(status, JSON.stringify(next), runId);
        return { ...event, cursor: Number(result.lastInsertRowid) };
      })
      .immediate();
  }

  /** 返回逻辑运行当前投影 */
  get(runId: string): RunTrace | undefined {
    const row = this.db.prepare("SELECT record FROM run_traces WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? (JSON.parse(row.record) as RunTrace) : undefined;
  }

  /** 使用不随状态变化的接受序号分页，避免活动运行更新导致漏项 */
  list(input: ListRunsInput = {}): RunPage {
    const limit = pageLimit(input.limit);
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (input.before !== undefined) {
      validateCursor(input.before);
      where.push("ordinal < ?");
      values.push(input.before);
    }
    if (input.status !== undefined && !STATES.has(input.status)) throw new Error("Invalid run status");
    for (const [column, value] of [
      ["status", input.status],
      ["session_id", input.sessionId],
      ["channel_id", input.channelId]
    ] as const) {
      if (value !== undefined) {
        where.push(`${column} = ?`);
        values.push(value);
      }
    }
    for (const [operator, value] of [
      [">=", input.since],
      ["<=", input.until]
    ] as const) {
      if (value !== undefined) {
        if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid time filter");
        where.push(`started_at ${operator} ?`);
        values.push(new Date(value).toISOString());
      }
    }
    const rows = this.db
      .prepare(
        `SELECT ordinal, record FROM run_traces ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ordinal DESC LIMIT ?`
      )
      .all(...values, limit + 1) as RunRow[];
    return {
      items: rows.slice(0, limit).map((row) => JSON.parse(row.record) as RunTrace),
      ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.ordinal } : {})
    };
  }

  /** 按运行内序号补读事件 */
  events(runId: string, afterSeq = 0, limit = 100): readonly RunEvent[] {
    validateCursor(afterSeq);
    return (
      this.db
        .prepare("SELECT cursor, record FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(runId, afterSeq, pageLimit(limit)) as EventRow[]
    ).map(eventFromRow);
  }

  /** 按持久全局游标读取事件，不依赖内存订阅是否在线 */
  stream(afterCursor = 0, limit = 100): readonly RunEvent[] {
    validateCursor(afterCursor);
    return (
      this.db
        .prepare("SELECT cursor, record FROM run_events WHERE cursor > ? ORDER BY cursor LIMIT ?")
        .all(afterCursor, pageLimit(limit)) as EventRow[]
    ).map(eventFromRow);
  }

  /** 当前全局游标上界 */
  highWaterMark(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(cursor), 0) AS value FROM run_events").get() as { value: number })
      .value;
  }

  /** 未结束的外部调用保守归为未知，只有无未决动作的中断允许后续安全恢复 */
  recover(): void {
    const rows = this.db
      .prepare("SELECT record FROM run_traces WHERE status IN ('accepted', 'running')")
      .all() as RunRow[];
    for (const row of rows) {
      const run = JSON.parse(row.record) as RunTrace;
      const events = (
        this.db.prepare("SELECT cursor, record FROM run_events WHERE run_id = ? ORDER BY seq").all(run.id) as EventRow[]
      ).map(eventFromRow);
      const pending = new Set<string>();
      for (const event of events) {
        if (event.type === "response_sending") pending.add("response");
        if (["response_sent", "response_send_failed"].includes(event.type)) pending.delete("response");
        if (event.type.startsWith("tool_call_")) {
          const data = event.data as { callId?: string } | null;
          const key = `tool:${data?.callId ?? event.id}`;
          if (event.type === "tool_call_started") pending.add(key);
          else pending.delete(key);
        }
        if (event.type === "artifact_upload_uncertain" || event.type === "response_send_uncertain")
          pending.add(event.id);
      }
      const status = pending.size > 0 ? "uncertain" : "interrupted";
      this.append(run.id, {
        key: `recovery:${run.lastSeq}`,
        type: status === "uncertain" ? "run_uncertain" : "run_interrupted",
        status,
        phase: "recovery",
        error: {
          code: status,
          message:
            status === "uncertain" ? "外部动作结果未确认，请人工核对，未自动重放" : "运行进程中断，已保留历史记录",
          phase: run.phase
        }
      });
    }
  }
}

function eventFromRow(row: EventRow): RunEvent {
  return { ...(JSON.parse(row.record) as Omit<RunEvent, "cursor">), cursor: row.cursor };
}
function validateId(value: string): void {
  if (!value || value.length > 2048) throw new Error("Invalid run identifier");
}
function validateCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid event cursor");
}
function pageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new Error("Invalid page limit");
  return value;
}
function validateTransition(from: RunStatus, to: RunStatus, type: AppendRunEventInput["type"]): void {
  if (!STATES.has(to)) throw new Error("Invalid run status");
  if (TERMINAL_EVENTS[type] !== undefined && TERMINAL_EVENTS[type] !== to) throw new Error("Run event status mismatch");
  if ((type === "run_started" || type === "run_resumed") && to !== "running")
    throw new Error("Run start status mismatch");
  if (from === "interrupted" && to === "running" && type === "run_resumed") return;
  if (!ACTIVE.has(from)) throw new Error("Run is terminal");
  if (type === "run_accepted" && from === "accepted" && to === from) return;
  if (type === "run_started" || type === "run_resumed" || type === "run_accepted") {
    if (from === "accepted" && to === "running" && type === "run_started") return;
    throw new Error("Invalid run start transition");
  }
  if (to === from && from === "running") return;
  if (TERMINAL_EVENTS[type] === to) return;
  throw new Error("Invalid run transition");
}
