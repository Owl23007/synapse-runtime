/** DAG 独立版本迁移，不改变旧上下文数据库的 user_version 契约 */
export const DAG_SCHEMA_SQL = `
CREATE TABLE dag_commit (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL CHECK(json_valid(content)),
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  created_at INTEGER NOT NULL,
  UNIQUE(scope_id, id)
);
CREATE TABLE dag_commit_parent (
  commit_id TEXT NOT NULL REFERENCES dag_commit(id),
  parent_id TEXT NOT NULL REFERENCES dag_commit(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(commit_id, position),
  UNIQUE(commit_id, parent_id)
);
CREATE INDEX dag_parent_reverse ON dag_commit_parent(parent_id);
CREATE TABLE dag_ref (
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id, name),
  FOREIGN KEY(scope_id, commit_id) REFERENCES dag_commit(scope_id, id)
);
CREATE TABLE dag_commit_request (
  scope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY(scope_id, idempotency_key),
  FOREIGN KEY(scope_id, commit_id) REFERENCES dag_commit(scope_id, id)
);
CREATE TRIGGER dag_commit_no_update BEFORE UPDATE ON dag_commit BEGIN
  SELECT RAISE(ABORT, 'DAG commits are immutable');
END;
CREATE TRIGGER dag_commit_no_delete BEFORE DELETE ON dag_commit BEGIN
  SELECT RAISE(ABORT, 'DAG commits are immutable');
END;
CREATE TRIGGER dag_parent_no_update BEFORE UPDATE ON dag_commit_parent BEGIN
  SELECT RAISE(ABORT, 'DAG parents are immutable');
END;
CREATE TRIGGER dag_parent_no_delete BEFORE DELETE ON dag_commit_parent BEGIN
  SELECT RAISE(ABORT, 'DAG parents are immutable');
END;
CREATE TRIGGER dag_request_no_update BEFORE UPDATE ON dag_commit_request BEGIN
  SELECT RAISE(ABORT, 'DAG commit receipts are immutable');
END;
CREATE TRIGGER dag_request_no_delete BEFORE DELETE ON dag_commit_request BEGIN
  SELECT RAISE(ABORT, 'DAG commit receipts are immutable');
END;
CREATE TRIGGER dag_parent_validate BEFORE INSERT ON dag_commit_parent BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM dag_commit child JOIN dag_commit parent
    ON child.scope_id = parent.scope_id AND parent.ordinal < child.ordinal
    WHERE child.id = NEW.commit_id AND parent.id = NEW.parent_id
  ) OR EXISTS (SELECT 1 FROM dag_commit_request WHERE commit_id = NEW.commit_id)
  THEN RAISE(ABORT, 'Invalid or sealed DAG ancestry') END;
END;
`;
