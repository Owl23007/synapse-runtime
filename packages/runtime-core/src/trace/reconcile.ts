import type Database from "better-sqlite3";
import type { RunTrace, RunTraceStore, RunEventType } from "./types.js";
import type { RunOutcome } from "./outcome.js";
import { decodeJson } from "../storage/sqlite/json-codec.js";

interface ReceiptRow {
  readonly ordinal: number;
  readonly id: string;
  readonly type: string;
  readonly payload_json: string | null;
  readonly created_at: string;
}

/** 以原始持久回执补齐崩溃窗口中的追踪，不发起任何外部调用 */
export function reconcileRunReceipts(
  db: Database.Database,
  store: RunTraceStore,
  run: RunTrace,
  attemptId: string | undefined,
  outcome: RunOutcome
): void {
  // 独立 Trace 仓储可以没有旧会话表，不能为旧数据伪造回执
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'line_events'").get()) return;
  for (const correlationId of [attemptId, run.sourceEventId]) {
    if (correlationId === undefined) continue;
    let cursor = 0;
    while (true) {
      const rows = db
        .prepare(`SELECT ordinal, id, type, payload_json, created_at FROM line_events
        WHERE session_id = ? AND correlation_id = ? AND ordinal > ?
        AND type IN ('tool_result', 'agent_run_failed', 'delivery_succeeded', 'delivery_failed', 'delivery_blocked', 'delivery_uncertain')
        ORDER BY ordinal LIMIT 200`)
        .all(run.sessionId, correlationId, cursor) as ReceiptRow[];
      for (const row of rows) {
        cursor = row.ordinal;
        const payload = (row.payload_json === null ? {} : decodeJson(row.payload_json, "recovery receipt")) as Record<
          string,
          unknown
        >;
        let type: RunEventType | undefined;
        if (row.type === "tool_result" && correlationId === attemptId) {
          type =
            payload.status === "succeeded"
              ? "tool_call_succeeded"
              : payload.status === "blocked"
                ? "tool_call_blocked"
                : payload.status === "failed"
                  ? "tool_call_failed"
                  : undefined;
        } else if (row.type === "agent_run_failed" && correlationId === attemptId) {
          outcome.fail("failed", "agent_failed", "智能体运行失败，已从持久回执恢复", "model");
        } else if (correlationId === run.sourceEventId && payload.runId === run.id) {
          if (row.type === "delivery_blocked")
            outcome.fail("blocked", "response_blocked", "消息发送被权限阻止", "response");
          else if (row.type === "delivery_succeeded") type = "response_sent";
          else if (row.type === "delivery_uncertain" || payload.thrown === true) type = "response_send_uncertain";
          else if (row.type === "delivery_failed") type = "response_send_failed";
        }
        if (type === undefined) continue;
        const event = store.append(run.id, {
          key: `receipt:${row.id}`,
          type,
          ...(attemptId === undefined ? {} : { attemptId }),
          data: { ...payload, recovered: true, receiptId: row.id, receiptOccurredAt: row.created_at }
        });
        outcome.observe(event.type, event.data);
      }
      if (rows.length < 200) break;
    }
  }
}
