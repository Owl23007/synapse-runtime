import type {
  BranchResult,
  ConversationLine,
  ConversationNode,
  ConversationSession,
  ConversationTask,
  LineEventType
} from "../../conversation/types.js";

export interface SessionRow {
  readonly id: string;
  readonly platform: string | null;
  readonly provider: string | null;
  readonly channel_id: string | null;
  readonly conversation_type: string | null;
  readonly conversation_id: string | null;
  readonly status: ConversationSession["status"];
  readonly mainline_id: string;
  readonly workspace_id: string | null;
  readonly metadata_json: string | null;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LineRow {
  readonly id: string;
  readonly session_id: string;
  readonly kind: ConversationLine["kind"];
  readonly status: ConversationLine["status"];
  readonly parent_mainline_id: string | null;
  readonly source_line_event_id: string | null;
  readonly create_request_id: string | null;
  readonly title: string | null;
  readonly goal: string | null;
  readonly reason: string | null;
  readonly created_by: string | null;
  readonly context_snapshot_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly merged_at: string | null;
  readonly archived_at: string | null;
}

export interface NormalizedEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string;
  readonly line_event_id: string;
  readonly platform: string;
  readonly provider: string;
  readonly channel_id: string;
  readonly conversation_type: string;
  readonly conversation_id: string;
  readonly source_event_id: string;
  readonly source_message_id: string | null;
  readonly source_event_type: string;
  readonly sender_id: string;
  readonly text: string;
  readonly message_json: string | null;
  readonly segments_json: string | null;
  readonly trigger_hint_json: string | null;
  readonly raw_payload_json: string | null;
  readonly received_at: string;
  readonly ingested_at: string;
  readonly idempotency_key: string;
}

export interface LineEventRow {
  readonly ordinal: number;
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string;
  readonly sequence: number;
  readonly type: LineEventType;
  readonly actor_id: string | null;
  readonly payload_json: string | null;
  readonly raw_payload_json: string | null;
  readonly source_normalized_event_id: string | null;
  readonly source_event_id: string | null;
  readonly idempotency_key: string;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
  readonly task_id: string | null;
  readonly created_at: string;
}

export interface TaskRow {
  readonly id: string;
  readonly session_id: string;
  readonly branch_line_id: string;
  readonly workspace_id: string | null;
  readonly executor: string;
  readonly status: ConversationTask["status"];
  readonly input_json: string;
  readonly output_json: string | null;
  readonly error_json: string | null;
  readonly artifacts_json: string;
  readonly create_request_id: string;
  readonly source_event_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly updated_at: string;
}

export interface ResultRow {
  readonly id: string;
  readonly session_id: string;
  readonly branch_line_id: string;
  readonly version: number;
  readonly status: BranchResult["status"];
  readonly summary: string;
  readonly artifacts_json: string;
  readonly citations_json: string;
  readonly next_actions_json: string;
  readonly create_request_id: string;
  readonly source_event_id: string | null;
  readonly created_at: string;
}

export interface MergeRow {
  readonly id: string;
  readonly session_id: string;
  readonly result_id: string;
  readonly branch_line_id: string;
  readonly mainline_id: string;
  readonly mainline_event_id: string;
  readonly branch_event_id: string;
  readonly create_request_id: string;
  readonly merged_at: string;
}

export interface NodeRow {
  readonly ordinal: number;
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string;
  readonly sequence: number;
  readonly parent_ids_json: string;
  readonly kind: ConversationNode["kind"];
  readonly title: string;
  readonly state_patch_json: string;
  readonly source_event_ids_json: string;
  readonly source_task_ids_json: string;
  readonly source_result_ids_json: string;
  readonly created_by: string;
  readonly create_request_id: string;
  readonly created_at: string;
}

export interface SnapshotRow {
  readonly id: string;
  readonly session_id: string;
  readonly line_id: string;
  readonly node_id: string;
  readonly node_ordinal: number;
  readonly state_json: string;
  readonly create_request_id: string;
  readonly created_at: string;
}
