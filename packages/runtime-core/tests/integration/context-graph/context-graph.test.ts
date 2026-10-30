import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { openRuntimeDatabase, closeRuntimeDatabase } from "../../../src/storage/sqlite/database.js";
import { SqliteContextGraphRepository } from "../../../src/storage/sqlite/context-graph-store.js";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import type { CommitInput } from "../../../src/context-graph/commit.js";

function open(path = ":memory:") {
  const db = openRuntimeDatabase(path);
  onTestFinished(() => closeRuntimeDatabase(db));
  return { db, graph: new SqliteContextGraphRepository(db) };
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

describe("提交与引用上下文图", () => {
  it("保持延迟任务结果独立并针对当前头进行合并", () => {
    const { graph } = open();
    const a = graph.commit(input("a"));
    graph.fork("space", "task:search", a.id, "task");
    const b = graph.commit(input("b", 1));
    const result = graph.commit(input("search", 1, "task:search"));
    expect(graph.getRef("space", "main")?.commitId).toBe(b.id);
    expect(result.parents).toEqual([a.id]);
    const merged = graph.merge({ ...input("merge", 2), additionalParents: [result.id] });
    expect(merged.parents).toEqual([b.id, result.id]);
    expect(graph.getCommit("space", a.id)).toEqual(a);
    const path = graph.resolveContextPath("space", "main");
    expect(path.commits.map((commit) => commit.id)).toEqual([a.id, b.id, result.id, merged.id]);
    expect(path.truncated).toBe(false);
    expect(graph.getRef("space", "task:search")?.commitId).toBe(result.id);
  });

  it("拒绝过期写入并在后续提交后保持重试稳定", () => {
    const { graph, db } = open();
    const a = graph.commit(input("a"));
    const b = graph.commit(input("b", 1));
    expect(graph.commit(input("a"))).toEqual(a);
    expect(graph.getRef("space", "main")?.commitId).toBe(b.id);
    expect(() => graph.commit(input("stale", 1))).toThrow("version conflict");
    expect(() => graph.commit({ ...input("a"), content: { text: "different" } })).toThrow("idempotency");
    expect(db.prepare("SELECT count(*) AS count FROM context_graph_commit").get()).toEqual({ count: 2 });
  });

  it("移动引用失败时回滚提交与回执", () => {
    const { graph, db } = open();
    db.exec(
      "CREATE TRIGGER fail_ref BEFORE INSERT ON context_graph_ref BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    );
    expect(() => graph.commit(input("a"))).toThrow("injected failure");
    expect(db.prepare("SELECT count(*) AS count FROM context_graph_commit").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM context_graph_commit_request").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_ref");
    expect(graph.commit(input("a")).parents).toEqual([]);
  });

  it("约束历史不可变性、父节点封闭、作用域边界与无环性", () => {
    const { graph, db } = open();
    const a = graph.commit(input("a"));
    const b = graph.commit(input("b", 1));
    expect(() => db.prepare("UPDATE context_graph_commit SET content = '{}' WHERE id = ?").run(a.id)).toThrow(
      "immutable"
    );
    expect(() => db.prepare("DELETE FROM context_graph_commit WHERE id = ?").run(a.id)).toThrow("immutable");
    expect(() => db.prepare("INSERT INTO context_graph_commit_parent VALUES (?, ?, 0)").run(a.id, b.id)).toThrow();
    expect(() => db.prepare("INSERT INTO context_graph_commit_parent VALUES (?, ?, 0)").run(a.id, a.id)).toThrow();
    expect(() =>
      db.prepare("UPDATE context_graph_commit_parent SET position = 2 WHERE commit_id = ?").run(b.id)
    ).toThrow("immutable");
    expect(() => graph.fork("other", "main", a.id)).toThrow("scope");
    expect(() => graph.commit({ ...input("other"), scopeId: "other", additionalParents: [a.id] })).toThrow("scope");
    expect(() => graph.commit({ ...input("missing", 2), additionalParents: ["absent"] })).toThrow();
    const root = graph.commit({ ...input("root"), scopeId: "other" });
    expect(() => db.prepare("INSERT INTO context_graph_commit_parent VALUES (?, ?, 0)").run(root.id, a.id)).toThrow();
    expect(() => db.prepare("UPDATE context_graph_ref SET commit_id = 'absent'").run()).toThrow();
  });

  it("限制历史读取并在字符预算内保留完整提交", () => {
    const { graph } = open();
    for (let index = 0; index < 80; index++) graph.commit(input(String(index), index || null));
    const path = graph.resolveContextPath("space", "main", { maxCommits: 5, maxChars: 10000 });
    expect(path.visitedCommits).toBe(5);
    expect(path.commits).toHaveLength(5);
    expect(path.truncated).toBe(true);
    const small = graph.resolveContextPath("space", "main", { maxCommits: 3, maxChars: 1 });
    expect(small.commits).toEqual([]);
    expect(small.usedChars).toBe(0);
    expect(small.truncated).toBe(true);
    expect(() => graph.resolveContextPath("space", "main", { maxCommits: 0 })).toThrow("budget");
  });

  it("重新连接后保留状态并防止独立连接的过期写入", () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-context-graph-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "runtime.sqlite");
    const first = open(path);
    first.graph.commit(input("a"));
    const second = open(path);
    first.graph.commit(input("b", 1));
    expect(() => second.graph.commit(input("c", 1))).toThrow("version conflict");
    expect(second.db.prepare("SELECT count(*) AS count FROM runtime_migrations").get()).toEqual({ count: 2 });
    closeRuntimeDatabase(first.db);
    closeRuntimeDatabase(second.db);
    const store = new SqliteRuntimeContextStore({ databasePath: path });
    onTestFinished(() => store.close());
    try {
      expect(store.contextGraph.getRef("space", "main")?.version).toBe(2);
      expect(store.contextGraph.resolveContextPath("space", "main").commits).toHaveLength(2);
    } finally {
      store.close();
      store.close();
    }
  });
});
