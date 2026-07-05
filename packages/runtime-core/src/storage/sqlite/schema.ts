export const RUNTIME_CONTEXT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
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
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    external_message_id TEXT
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

  CREATE UNIQUE INDEX IF NOT EXISTS idx_event_process_unique
  ON event_process_state(
    platform,
    provider,
    channel_id,
    conversation_type,
    conversation_id,
    source_event_id
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
`;
