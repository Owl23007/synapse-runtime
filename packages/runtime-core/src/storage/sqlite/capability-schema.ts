/** 安装快照、工作区授权与运行依赖各自持久化，升级仅切换指针 */
export const CAPABILITY_SCHEMA_SQL = `
CREATE TABLE capability_installs (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp')),
 package_key TEXT NOT NULL,
 source_json TEXT NOT NULL,
 source_version TEXT,
 source_revision TEXT,
 content_digest TEXT NOT NULL,
 install_path TEXT,
 metadata_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('installed','disabled','failed')),
 installed_at TEXT NOT NULL,
 UNIQUE(package_key, content_digest, source_json), UNIQUE(id, package_key)
);
CREATE TABLE workspace_capabilities (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 package_key TEXT NOT NULL,
 install_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 settings_json TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id, package_key),
 FOREIGN KEY(install_id, package_key) REFERENCES capability_installs(id, package_key)
);
CREATE TABLE capability_audit (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 workspace_id TEXT, package_key TEXT NOT NULL, from_install_id TEXT, to_install_id TEXT,
 details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE run_dependencies (
 run_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE run_capabilities (
 run_id TEXT NOT NULL REFERENCES run_dependencies(run_id),
 install_id TEXT NOT NULL REFERENCES capability_installs(id),
 PRIMARY KEY(run_id, install_id)
);
CREATE TRIGGER capability_snapshot_immutable BEFORE UPDATE OF kind, package_key, source_json, source_version, source_revision, content_digest, install_path, metadata_json ON capability_installs
BEGIN SELECT RAISE(ABORT, 'Capability snapshots are immutable'); END;
CREATE TRIGGER asset_run_dependency AFTER INSERT ON asset_refs
WHEN NEW.ref_type = 'run' AND NEW.version_id IS NOT NULL
BEGIN
 UPDATE run_dependencies SET snapshot_json = json_insert(snapshot_json, '$.assets[#]',
   json_object('assetId', NEW.asset_id, 'versionId', NEW.version_id, 'sha256', (SELECT sha256 FROM asset_versions WHERE id = NEW.version_id)))
 WHERE run_id = NEW.ref_id AND workspace_id = NEW.workspace_id;
END;
`;
