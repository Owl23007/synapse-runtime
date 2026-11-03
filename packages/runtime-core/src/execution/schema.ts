/** 持久执行领域表，授权、计划、目标和副作用各自保持独立身份 */
export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_schema (version INTEGER PRIMARY KEY CHECK(version = 2));
INSERT OR IGNORE INTO execution_schema VALUES (2);
CREATE TABLE IF NOT EXISTS execution_grants (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal_id TEXT NOT NULL,
 session_id TEXT, expires_at INTEGER NOT NULL CHECK(expires_at > 0), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), record TEXT NOT NULL CHECK(json_valid(record)),
 UNIQUE(id, workspace_id)
);
CREATE TABLE IF NOT EXISTS agent_tasks (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal_id TEXT NOT NULL,
 parent_id TEXT, revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL CHECK(status IN ('open','paused','completed','cancelled')),
 creation_key TEXT NOT NULL, creation_request TEXT NOT NULL, record TEXT NOT NULL,
 UNIQUE(workspace_id, principal_id, creation_key), UNIQUE(id, workspace_id, principal_id),
 FOREIGN KEY(parent_id, workspace_id, principal_id) REFERENCES agent_tasks(id, workspace_id, principal_id)
);
CREATE TABLE IF NOT EXISTS agent_schedules (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES execution_grants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 task_id TEXT REFERENCES agent_tasks(id), revision INTEGER NOT NULL CHECK(revision > 0), status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled')), next_fire_at INTEGER NOT NULL,
 creation_key TEXT NOT NULL, creation_request TEXT NOT NULL, record TEXT NOT NULL,
 UNIQUE(grant_id, creation_key), UNIQUE(id, grant_id, workspace_id),
 FOREIGN KEY(grant_id, workspace_id) REFERENCES execution_grants(id, workspace_id)
);
CREATE INDEX IF NOT EXISTS agent_schedule_due ON agent_schedules(status, next_fire_at);
CREATE TABLE IF NOT EXISTS execution_intents (
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE REFERENCES run_traces(id),
 grant_id TEXT NOT NULL REFERENCES execution_grants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 task_id TEXT REFERENCES agent_tasks(id), schedule_id TEXT REFERENCES agent_schedules(id),
 state TEXT NOT NULL CHECK(state IN ('queued','claimed','done','blocked')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 created_at INTEGER NOT NULL, record TEXT NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(grant_id, workspace_id) REFERENCES execution_grants(id, workspace_id),
 FOREIGN KEY(schedule_id, grant_id, workspace_id) REFERENCES agent_schedules(id, grant_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS intent_queue ON execution_intents(state, ordinal);
CREATE INDEX IF NOT EXISTS intent_workspace_time ON execution_intents(workspace_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS task_single_writer ON execution_intents(task_id) WHERE state = 'claimed' AND task_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS schedule_occurrences (
 schedule_id TEXT NOT NULL REFERENCES agent_schedules(id), revision INTEGER NOT NULL, due_at INTEGER NOT NULL,
 intent_id TEXT REFERENCES execution_intents(id), status TEXT NOT NULL CHECK(status IN ('accepted','skipped')), created_at INTEGER NOT NULL,
 PRIMARY KEY(schedule_id, revision, due_at)
);
CREATE TABLE IF NOT EXISTS execution_inbox (
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run_traces(id),
 event_key TEXT NOT NULL, content TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 created_at INTEGER NOT NULL, UNIQUE(run_id, event_key)
);
CREATE INDEX IF NOT EXISTS inbox_pending ON execution_inbox(run_id, consumed, ordinal);
CREATE TABLE IF NOT EXISTS execution_input_receipts (
 event_id TEXT PRIMARY KEY REFERENCES normalized_events(id), run_id TEXT NOT NULL REFERENCES run_traces(id)
);
CREATE TABLE IF NOT EXISTS observed_inputs (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, principal_id TEXT NOT NULL, context_eligible INTEGER NOT NULL CHECK(context_eligible IN (0,1)),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observation_scope ON observed_inputs(session_id, expires_at, created_at);
CREATE INDEX IF NOT EXISTS observation_expiry ON observed_inputs(expires_at);
CREATE TABLE IF NOT EXISTS execution_operations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run_traces(id), name TEXT NOT NULL, input TEXT NOT NULL,
 effect TEXT NOT NULL CHECK(effect IN ('external','transactional','read')),
 state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed','blocked','uncertain')), result TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS operation_run ON execution_operations(run_id, state);
CREATE TABLE IF NOT EXISTS execution_usage (
 run_id TEXT PRIMARY KEY REFERENCES run_traces(id), model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls >= 0), tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0)
);
CREATE TABLE IF NOT EXISTS execution_results (
 run_id TEXT PRIMARY KEY REFERENCES run_traces(id), outcome TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;
