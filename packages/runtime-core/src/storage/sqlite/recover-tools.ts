import type Database from "better-sqlite3";
import type { RunTraceStore } from "../../trace/types.js";
import type { SqliteConversationRepository } from "./conversation-store.js";
import { decodeJson } from "./json-codec.js";

/** 只读外部持久回执核对输入，目标来源于已接受的规范化事件 */
export interface RecoverToolOutputInput {
  readonly sessionId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly name: string;
  readonly input: unknown;
}

/** 仅返回已存在的工具输出，找不到可靠回执时不得推测成功 */
export type RecoverToolOutput = (input: RecoverToolOutputInput) => Readonly<Record<string, unknown>> | undefined;

interface StartedRow {
  readonly ordinal: number;
  readonly id: string;
  readonly line_id: string;
  readonly source_event_id: string | null;
  readonly actor_id: string | null;
  readonly task_id: string | null;
  readonly payload_json: string;
}

/** 把已落盘的宿主回执补为原会话工具结果，使后续安全恢复仍能命中去重记录 */
export function recoverToolOutputs(
  db: Database.Database,
  runs: RunTraceStore,
  conversation: SqliteConversationRepository,
  resolve: RecoverToolOutput
): void {
  let before: number | undefined;
  do {
    const page = runs.list({ status: "running", limit: 100, ...(before === undefined ? {} : { before }) });
    for (const run of page.items) {
      const started = runs.latestEvent(run.id, "run_started");
      const resumed = runs.latestEvent(run.id, "run_resumed");
      const attemptId = (resumed && resumed.seq > (started?.seq ?? 0) ? resumed : started)?.attemptId;
      if (attemptId === undefined) continue;
      const origin = db
        .prepare(
          "SELECT conversation_id, conversation_type FROM normalized_events WHERE id = ? AND session_id = ? AND channel_id = ?"
        )
        .get(run.sourceEventId, run.sessionId, run.channelId) as
        | { conversation_id: string; conversation_type: string }
        | undefined;
      if (origin === undefined) continue;
      let cursor = 0;
      while (true) {
        const rows = db
          .prepare(
            "SELECT ordinal, id, line_id, source_event_id, actor_id, task_id, payload_json FROM line_events WHERE session_id = ? AND correlation_id = ? AND type = 'tool_call' AND ordinal > ? ORDER BY ordinal LIMIT 100"
          )
          .all(run.sessionId, attemptId, cursor) as StartedRow[];
        for (const row of rows) {
          cursor = row.ordinal;
          const payload = decodeJson(row.payload_json, "tool recovery") as Record<string, unknown>;
          if (typeof payload.callId !== "string" || typeof payload.name !== "string") continue;
          const key = `tool:${payload.callId}:`;
          const terminal = db
            .prepare("SELECT id FROM line_events WHERE line_id = ? AND idempotency_key IN (?, ?, ?, ?) LIMIT 1")
            .get(
              row.line_id,
              `${key}tool_call_succeeded`,
              `${key}tool_call_failed`,
              `${key}tool_call_blocked`,
              `${key}tool_call_uncertain`
            );
          if (terminal) continue;
          const output = resolve({
            sessionId: run.sessionId,
            channelId: run.channelId,
            conversationId: origin.conversation_id,
            conversationType: origin.conversation_type,
            name: payload.name,
            input: payload.input
          });
          if (output === undefined) continue;
          conversation.appendEventSync(row.line_id, {
            type: "tool_result",
            idempotencyKey: `${key}tool_call_succeeded`,
            correlationId: attemptId,
            causationEventId: row.id,
            ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
            ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
            ...(row.task_id === null ? {} : { taskId: row.task_id }),
            payload: { ...payload, status: "succeeded", output, recovered: true }
          });
        }
        if (rows.length < 100) break;
      }
    }
    before = page.nextCursor;
  } while (before !== undefined);
}
