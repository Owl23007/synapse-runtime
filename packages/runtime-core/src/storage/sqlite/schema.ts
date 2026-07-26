export const RUNTIME_CONTEXT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_sessions (
    id TEXT PRIMARY KEY,
    platform TEXT,
    provider TEXT,
    channel_id TEXT,
    conversation_type TEXT
      CHECK(conversation_type IS NULL OR conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
    conversation_id TEXT,
    status TEXT NOT NULL
      CHECK(status IN ('active', 'archived')),
    mainline_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT,
    metadata_json TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(
      (platform IS NULL
        AND provider IS NULL
        AND channel_id IS NULL
        AND conversation_type IS NULL
        AND conversation_id IS NULL)
      OR
      (platform IS NOT NULL
        AND provider IS NOT NULL
        AND channel_id IS NOT NULL
        AND conversation_type IS NOT NULL
        AND conversation_id IS NOT NULL)
    ),
    UNIQUE(
      platform,
      provider,
      channel_id,
      conversation_type,
      conversation_id
    )
  );

  CREATE TABLE IF NOT EXISTS conversation_lines (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK(kind IN ('mainline', 'branch')),
    status TEXT NOT NULL
      CHECK(status IN (
        'created',
        'active',
        'blocked',
        'inactive',
        'completed',
        'merged',
        'failed',
        'cancelled',
        'archived'
      )),
    parent_mainline_id TEXT,
    source_line_event_id TEXT,
    create_request_id TEXT,
    title TEXT,
    goal TEXT,
    reason TEXT,
    created_by TEXT,
    context_snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    merged_at TEXT,
    archived_at TEXT,
    CHECK(
      (kind = 'mainline'
        AND status IN ('active', 'archived')
        AND parent_mainline_id IS NULL
        AND source_line_event_id IS NULL
        AND create_request_id IS NULL
        AND title IS NULL
        AND goal IS NULL
        AND reason IS NULL
        AND created_by IS NULL)
      OR
      (kind = 'branch'
        AND parent_mainline_id IS NOT NULL
        AND source_line_event_id IS NOT NULL
        AND create_request_id IS NOT NULL
        AND title IS NOT NULL
        AND goal IS NOT NULL
        AND reason IS NOT NULL
        AND created_by IS NOT NULL)
    ),
    FOREIGN KEY(session_id) REFERENCES conversation_sessions(id),
    FOREIGN KEY(parent_mainline_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(source_line_event_id) REFERENCES line_events(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_mainline_unique
  ON conversation_lines(session_id)
  WHERE kind = 'mainline';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_branch_request_unique
  ON conversation_lines(session_id, create_request_id)
  WHERE kind = 'branch';

  CREATE INDEX IF NOT EXISTS idx_conversation_branch_status
  ON conversation_lines(session_id, kind, status, updated_at);

  CREATE TABLE IF NOT EXISTS normalized_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    provider TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL
      CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
    conversation_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_message_id TEXT,
    source_event_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    message_json TEXT,
    segments_json TEXT,
    trigger_hint_json TEXT,
    raw_payload_json TEXT,
    received_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES conversation_sessions(id),
    UNIQUE(
      platform,
      provider,
      channel_id,
      source_event_id,
      source_event_type
    ),
    UNIQUE(idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS idx_normalized_event_session_received
  ON normalized_events(session_id, received_at);

  CREATE TABLE IF NOT EXISTS line_events (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    role TEXT
      CHECK(role IS NULL OR role IN ('user', 'assistant', 'system')),
    actor_id TEXT,
    text TEXT,
    payload_json TEXT,
    raw_payload_json TEXT,
    source_normalized_event_id TEXT,
    source_event_id TEXT,
    idempotency_key TEXT NOT NULL,
    causation_event_id TEXT,
    correlation_id TEXT,
    task_id TEXT,
    branch_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES conversation_sessions(id),
    FOREIGN KEY(line_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(source_normalized_event_id) REFERENCES normalized_events(id),
    FOREIGN KEY(causation_event_id) REFERENCES line_events(id),
    FOREIGN KEY(branch_id) REFERENCES conversation_lines(id),
    UNIQUE(line_id, sequence),
    UNIQUE(line_id, idempotency_key)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_line_event_normalized_source
  ON line_events(source_normalized_event_id)
  WHERE source_normalized_event_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_line_event_recent
  ON line_events(line_id, sequence DESC);

  CREATE INDEX IF NOT EXISTS idx_line_event_correlation
  ON line_events(correlation_id, ordinal);

  CREATE INDEX IF NOT EXISTS idx_line_event_causation
  ON line_events(causation_event_id);

  CREATE TABLE IF NOT EXISTS conversation_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    branch_line_id TEXT NOT NULL,
    workspace_id TEXT,
    executor TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN ('pending', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
    input_json TEXT NOT NULL,
    output_json TEXT,
    error_json TEXT,
    artifacts_json TEXT NOT NULL,
    create_request_id TEXT NOT NULL,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES conversation_sessions(id),
    FOREIGN KEY(branch_line_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(source_event_id) REFERENCES line_events(id),
    UNIQUE(branch_line_id, create_request_id)
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_task_recovery
  ON conversation_tasks(session_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS branch_results (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    branch_line_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    status TEXT NOT NULL
      CHECK(status IN ('completed', 'failed', 'cancelled')),
    summary TEXT NOT NULL,
    artifacts_json TEXT NOT NULL,
    citations_json TEXT NOT NULL,
    next_actions_json TEXT NOT NULL,
    create_request_id TEXT NOT NULL,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES conversation_sessions(id),
    FOREIGN KEY(branch_line_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(source_event_id) REFERENCES line_events(id),
    UNIQUE(branch_line_id, version),
    UNIQUE(branch_line_id, create_request_id)
  );

  CREATE TABLE IF NOT EXISTS branch_result_tasks (
    result_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    PRIMARY KEY(result_id, task_id),
    FOREIGN KEY(result_id) REFERENCES branch_results(id),
    FOREIGN KEY(task_id) REFERENCES conversation_tasks(id)
  );

  CREATE TABLE IF NOT EXISTS branch_merges (
    id TEXT PRIMARY KEY,
    result_id TEXT NOT NULL,
    branch_line_id TEXT NOT NULL,
    mainline_id TEXT NOT NULL,
    mainline_event_id TEXT NOT NULL,
    branch_event_id TEXT NOT NULL,
    create_request_id TEXT NOT NULL,
    merged_at TEXT NOT NULL,
    FOREIGN KEY(result_id) REFERENCES branch_results(id),
    FOREIGN KEY(branch_line_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(mainline_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(mainline_event_id) REFERENCES line_events(id),
    FOREIGN KEY(branch_event_id) REFERENCES line_events(id),
    UNIQUE(result_id, mainline_id),
    UNIQUE(branch_line_id, create_request_id),
    UNIQUE(mainline_event_id),
    UNIQUE(branch_event_id)
  );

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    line_id TEXT,
    normalized_event_id TEXT,
    line_event_id TEXT,
    platform TEXT NOT NULL,
    provider TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL
      CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
    conversation_id TEXT NOT NULL,
    source_event_id TEXT,
    role TEXT NOT NULL
      CHECK(role IN ('user', 'assistant', 'system')),
    actor_id TEXT,
    text TEXT NOT NULL,
    message_json TEXT,
    raw_payload_json TEXT,
    event_type TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    external_message_id TEXT,
    FOREIGN KEY(line_id) REFERENCES conversation_lines(id),
    FOREIGN KEY(normalized_event_id) REFERENCES normalized_events(id),
    FOREIGN KEY(line_event_id) REFERENCES line_events(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_source_event
  ON conversation_messages(
    platform,
    provider,
    channel_id,
    conversation_type,
    conversation_id,
    source_event_id
  )
  WHERE source_event_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_conv_recent
  ON conversation_messages(session_id, deleted_at, created_at);

  CREATE TABLE IF NOT EXISTS event_process_state (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    provider TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL
      CHECK(conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
    conversation_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_event_type TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN (
        'received',
        'processing',
        'agent_completed',
        'send_succeeded',
        'send_failed',
        'completed'
      )),
    incoming_message_id TEXT,
    assistant_message_id TEXT,
    agent_output_text TEXT,
    agent_output_json TEXT,
    send_result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(incoming_message_id) REFERENCES conversation_messages(id),
    FOREIGN KEY(assistant_message_id) REFERENCES conversation_messages(id)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL
      CHECK(type IN ('personal', 'group', 'system')),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workspace_bindings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    binding_type TEXT NOT NULL
      CHECK(binding_type IN ('identity', 'conversation')),
    identity_id TEXT,
    platform TEXT,
    provider TEXT,
    channel_id TEXT,
    conversation_type TEXT
      CHECK(conversation_type IS NULL OR conversation_type IN ('private', 'group', 'channel', 'cli', 'system')),
    conversation_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK(
      (binding_type = 'identity'
        AND identity_id IS NOT NULL
        AND platform IS NULL
        AND provider IS NULL
        AND channel_id IS NULL
        AND conversation_type IS NULL
        AND conversation_id IS NULL)
      OR
      (binding_type = 'conversation'
        AND identity_id IS NULL
        AND platform IS NOT NULL
        AND provider IS NOT NULL
        AND channel_id IS NOT NULL
        AND conversation_type IS NOT NULL
        AND conversation_id IS NOT NULL)
    ),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_identity
  ON workspace_bindings(workspace_id, identity_id)
  WHERE binding_type = 'identity' AND deleted_at IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_binding_conversation
  ON workspace_bindings(
    workspace_id,
    platform,
    provider,
    channel_id,
    conversation_type,
    conversation_id
  )
  WHERE binding_type = 'conversation' AND deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL
      CHECK(scope_type IN ('identity', 'workspace')),
    scope_id TEXT NOT NULL,
    identity_id TEXT,
    workspace_id TEXT,
    visibility TEXT NOT NULL
      CHECK(visibility IN ('private', 'workspace', 'public', 'secret')),
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK(
      (scope_type = 'identity'
        AND identity_id IS NOT NULL
        AND workspace_id IS NULL)
      OR
      (scope_type = 'workspace'
        AND identity_id IS NULL
        AND workspace_id IS NOT NULL)
    ),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_scope_created
  ON memory_records(scope_type, scope_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_memory_visibility
  ON memory_records(visibility, identity_id, workspace_id, deleted_at);
`;

export const RUNTIME_CONTEXT_POST_MIGRATION_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_event_process_unique
  ON event_process_state(
    platform,
    provider,
    channel_id,
    source_event_id,
    source_event_type
  );

  CREATE INDEX IF NOT EXISTS idx_conv_external_message
  ON conversation_messages(
    platform,
    provider,
    channel_id,
    conversation_type,
    conversation_id,
    external_message_id
  )
  WHERE external_message_id IS NOT NULL AND role = 'assistant' AND deleted_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_conv_line_recent
  ON conversation_messages(line_id, deleted_at, created_at);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_normalized_event
  ON conversation_messages(normalized_event_id)
  WHERE normalized_event_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_line_event
  ON conversation_messages(line_event_id)
  WHERE line_event_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_idempotency
  ON conversation_messages(session_id, COALESCE(line_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;
