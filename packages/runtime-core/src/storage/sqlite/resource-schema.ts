/** 文件资源增量结构，复合外键保证版本及来源不能跨工作区串联 */
export const RESOURCE_SCHEMA_SQL = `
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255),
  declared_mime TEXT,
  declared_size_bytes INTEGER CHECK(declared_size_bytes IS NULL OR declared_size_bytes >= 0),
  current_version_id TEXT,
  fetch_state TEXT CHECK(fetch_state IN ('fetch-failed', 'remote-unavailable')),
  fetch_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(id, workspace_id),
  FOREIGN KEY(current_version_id, id) REFERENCES asset_versions(id, asset_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_assets_workspace ON assets(workspace_id, deleted_at, updated_at DESC, id);
CREATE TABLE asset_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('qq_group','qq_private','native','artifact','mount')),
  source_key TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(workspace_id, source_kind, source_key),
  FOREIGN KEY(asset_id, workspace_id) REFERENCES assets(id, workspace_id)
);
CREATE INDEX idx_asset_sources_asset ON asset_sources(asset_id);
CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  detected_mime TEXT NOT NULL,
  blob_key TEXT NOT NULL CHECK(blob_key = sha256),
  created_at TEXT NOT NULL,
  UNIQUE(asset_id, version_no),
  UNIQUE(id, asset_id)
);
CREATE TRIGGER asset_versions_immutable BEFORE UPDATE ON asset_versions
BEGIN SELECT RAISE(ABORT, 'Asset versions are immutable'); END;
CREATE TRIGGER asset_workspace_immutable BEFORE UPDATE OF workspace_id ON assets
WHEN NEW.workspace_id != OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'Asset workspace is immutable'); END;
CREATE TABLE asset_refs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  version_id TEXT,
  ref_type TEXT NOT NULL CHECK(ref_type IN ('message','run','task','artifact')),
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(ref_type NOT IN ('run','task') OR version_id IS NOT NULL),
  FOREIGN KEY(asset_id, workspace_id) REFERENCES assets(id, workspace_id),
  FOREIGN KEY(version_id, asset_id) REFERENCES asset_versions(id, asset_id)
);
CREATE UNIQUE INDEX idx_asset_refs_version ON asset_refs(workspace_id, ref_type, ref_id, asset_id, version_id) WHERE version_id IS NOT NULL;
CREATE UNIQUE INDEX idx_asset_refs_discovery ON asset_refs(workspace_id, ref_type, ref_id, asset_id) WHERE version_id IS NULL;
CREATE INDEX idx_asset_refs_target ON asset_refs(workspace_id, ref_type, ref_id);
CREATE TABLE asset_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  asset_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK(expected_size >= 0),
  version_id TEXT REFERENCES asset_versions(id),
  expires_at TEXT NOT NULL,
  UNIQUE(workspace_id, idempotency_key)
);
CREATE TABLE session_workspaces (
  session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id)
);
`;
