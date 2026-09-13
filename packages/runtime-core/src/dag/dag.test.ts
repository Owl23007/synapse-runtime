import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../storage/sqlite/database.js";
import { SqliteDagRepository } from "../storage/sqlite/dag-store.js";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import type { CommitInput } from "./types.js";

const connections: Database.Database[] = [];
const directories: string[] = [];
function open(path = ":memory:") {
  const db = openRuntimeDatabase(path);
  connections.push(db);
  return { db, dag: new SqliteDagRepository(db) };
}
function input(key: string, version: number | null = null, refName = "main"): CommitInput {
  return {
    scopeId: "space",
    refName,
    expectedVersion: version,
    idempotencyKey: key,
    type: "result",
    content: { text: key }
  };
}
afterEach(() => {
  connections.splice(0).forEach(closeRuntimeDatabase);
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("Commit / Ref context graph", () => {
  it("keeps delayed task results independent and merges against the current head", () => {
    const { dag } = open();
    const a = dag.commit(input("a"));
    dag.fork("space", "task:search", a.id, "task");
    const b = dag.commit(input("b", 1));
    const result = dag.commit(input("search", 1, "task:search"));
    expect(dag.getRef("space", "main")?.commitId).toBe(b.id);
    expect(result.parents).toEqual([a.id]);
    const merged = dag.merge({ ...input("merge", 2), additionalParents: [result.id] });
    expect(merged.parents).toEqual([b.id, result.id]);
    expect(dag.getCommit("space", a.id)).toEqual(a);
    const path = dag.resolveContextPath("space", "main");
    expect(path.commits.map((commit) => commit.id)).toEqual([a.id, b.id, result.id, merged.id]);
    expect(path.truncated).toBe(false);
    expect(dag.getRef("space", "task:search")?.commitId).toBe(result.id);
  });

  it("rejects stale writers and makes retries stable after subsequent commits", () => {
    const { dag, db } = open();
    const a = dag.commit(input("a"));
    const b = dag.commit(input("b", 1));
    expect(dag.commit(input("a"))).toEqual(a);
    expect(dag.getRef("space", "main")?.commitId).toBe(b.id);
    expect(() => dag.commit(input("stale", 1))).toThrow("version conflict");
    expect(() => dag.commit({ ...input("a"), content: { text: "different" } })).toThrow("idempotency");
    expect(db.prepare("SELECT count(*) AS count FROM dag_commit").get()).toEqual({ count: 2 });
  });

  it("rolls back the commit and its receipt if moving the ref fails", () => {
    const { dag, db } = open();
    db.exec("CREATE TRIGGER fail_ref BEFORE INSERT ON dag_ref BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => dag.commit(input("a"))).toThrow("injected failure");
    expect(db.prepare("SELECT count(*) AS count FROM dag_commit").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM dag_commit_request").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_ref");
    expect(dag.commit(input("a")).parents).toEqual([]);
  });

  it("enforces immutable history, sealed parents, scope boundaries and acyclicity", () => {
    const { dag, db } = open();
    const a = dag.commit(input("a"));
    const b = dag.commit(input("b", 1));
    expect(() => db.prepare("UPDATE dag_commit SET content = '{}' WHERE id = ?").run(a.id)).toThrow("immutable");
    expect(() => db.prepare("DELETE FROM dag_commit WHERE id = ?").run(a.id)).toThrow("immutable");
    expect(() => db.prepare("INSERT INTO dag_commit_parent VALUES (?, ?, 0)").run(a.id, b.id)).toThrow();
    expect(() => db.prepare("INSERT INTO dag_commit_parent VALUES (?, ?, 0)").run(a.id, a.id)).toThrow();
    expect(() => db.prepare("UPDATE dag_commit_parent SET position = 2 WHERE commit_id = ?").run(b.id)).toThrow(
      "immutable"
    );
    expect(() => dag.fork("other", "main", a.id)).toThrow("scope");
    expect(() => dag.commit({ ...input("other"), scopeId: "other", additionalParents: [a.id] })).toThrow("scope");
    expect(() => dag.commit({ ...input("missing", 2), additionalParents: ["absent"] })).toThrow();
    const root = dag.commit({ ...input("root"), scopeId: "other" });
    expect(() => db.prepare("INSERT INTO dag_commit_parent VALUES (?, ?, 0)").run(root.id, a.id)).toThrow();
    expect(() => db.prepare("UPDATE dag_ref SET commit_id = 'absent'").run()).toThrow();
  });

  it("bounds history reads and preserves whole commits under the character budget", () => {
    const { dag } = open();
    for (let index = 0; index < 80; index++) dag.commit(input(String(index), index || null));
    const path = dag.resolveContextPath("space", "main", { maxCommits: 5, maxChars: 10000 });
    expect(path.visitedCommits).toBe(5);
    expect(path.commits).toHaveLength(5);
    expect(path.truncated).toBe(true);
    const small = dag.resolveContextPath("space", "main", { maxCommits: 3, maxChars: 1 });
    expect(small.commits).toEqual([]);
    expect(small.usedChars).toBe(0);
    expect(small.truncated).toBe(true);
    expect(() => dag.resolveContextPath("space", "main", { maxCommits: 0 })).toThrow("budget");
  });

  it("persists across reconnects and protects against stale writers on separate connections", () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-dag-"));
    directories.push(directory);
    const path = join(directory, "runtime.sqlite");
    const first = open(path);
    first.dag.commit(input("a"));
    const second = open(path);
    first.dag.commit(input("b", 1));
    expect(() => second.dag.commit(input("c", 1))).toThrow("version conflict");
    expect(second.db.prepare("SELECT count(*) AS count FROM runtime_migrations").get()).toEqual({ count: 2 });
    closeRuntimeDatabase(first.db);
    closeRuntimeDatabase(second.db);
    const store = new SqliteRuntimeContextStore({ databasePath: path });
    try {
      expect(store.dag.getRef("space", "main")?.version).toBe(2);
      expect(store.dag.resolveContextPath("space", "main").commits).toHaveLength(2);
    } finally {
      store.close();
      store.close();
    }
  });
});
