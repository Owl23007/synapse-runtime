/** 上下文图初始表结构，以提交、父关系和引用表达上下文演化 */
export const CONTEXT_GRAPH_SCHEMA_SQL = `
CREATE TABLE context_graph_commit (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL CHECK(json_valid(content)),
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  created_at INTEGER NOT NULL,
  UNIQUE(scope_id, id)
);
CREATE TABLE context_graph_commit_parent (
  commit_id TEXT NOT NULL REFERENCES context_graph_commit(id),
  parent_id TEXT NOT NULL REFERENCES context_graph_commit(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(commit_id, position),
  UNIQUE(commit_id, parent_id)
);
CREATE INDEX context_graph_parent_reverse ON context_graph_commit_parent(parent_id);
CREATE TABLE context_graph_ref (
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id, name),
  FOREIGN KEY(scope_id, commit_id) REFERENCES context_graph_commit(scope_id, id)
);
CREATE TABLE context_graph_commit_request (
  scope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY(scope_id, idempotency_key),
  FOREIGN KEY(scope_id, commit_id) REFERENCES context_graph_commit(scope_id, id)
);
CREATE TRIGGER context_graph_commit_no_update BEFORE UPDATE ON context_graph_commit BEGIN
  SELECT RAISE(ABORT, 'Context graph commits are immutable');
END;
CREATE TRIGGER context_graph_commit_no_delete BEFORE DELETE ON context_graph_commit BEGIN
  SELECT RAISE(ABORT, 'Context graph commits are immutable');
END;
CREATE TRIGGER context_graph_parent_no_update BEFORE UPDATE ON context_graph_commit_parent BEGIN
  SELECT RAISE(ABORT, 'Context graph parents are immutable');
END;
CREATE TRIGGER context_graph_parent_no_delete BEFORE DELETE ON context_graph_commit_parent BEGIN
  SELECT RAISE(ABORT, 'Context graph parents are immutable');
END;
CREATE TRIGGER context_graph_request_no_update BEFORE UPDATE ON context_graph_commit_request BEGIN
  SELECT RAISE(ABORT, 'Context graph commit receipts are immutable');
END;
CREATE TRIGGER context_graph_request_no_delete BEFORE DELETE ON context_graph_commit_request BEGIN
  SELECT RAISE(ABORT, 'Context graph commit receipts are immutable');
END;
CREATE TRIGGER context_graph_parent_validate BEFORE INSERT ON context_graph_commit_parent BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM context_graph_commit child JOIN context_graph_commit parent
    ON child.scope_id = parent.scope_id AND parent.ordinal < child.ordinal
    WHERE child.id = NEW.commit_id AND parent.id = NEW.parent_id
  ) OR EXISTS (SELECT 1 FROM context_graph_commit_request WHERE commit_id = NEW.commit_id)
  THEN RAISE(ABORT, 'Invalid or sealed Context graph ancestry') END;
END;
`;
