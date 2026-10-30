import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { SqliteRunTraceStore } from "../../../src/trace/sqlite-store.js";
import { redactTrace } from "../../../src/trace/redact.js";

function open() {
  const directory = mkdtempSync(join(tmpdir(), "synapse-run-trace-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const store = new SqliteRuntimeContextStore({ databasePath: path, traceSecrets: ["canary-secret-2874"] });
  onTestFinished(() => store.close());
  return { path, store, runs: store.runs };
}
const input = { sessionId: "session-a", channelId: "channel-a", sourceEventId: "source-a", summary: "生成表格" };

describe("持久运行追踪", () => {
  it("幂等接受且按频道和会话隔离平台事件", () => {
    const { runs } = open();
    const first = runs.accept(input);
    expect(runs.accept(input)).toEqual(first);
    expect(runs.accept({ ...input, channelId: "channel-b" }).id).not.toBe(first.id);
    expect(runs.accept({ ...input, sessionId: "session-b" }).id).not.toBe(first.id);
    expect(runs.events(first.id).map((event) => event.type)).toEqual(["run_accepted"]);
    expect(() => runs.accept({ ...input, lineId: "other-line" })).toThrow("identity conflict");
  });

  it("单 Run 序号和全局游标独立，幂等追加拒绝冲突", () => {
    const { runs } = open();
    const a = runs.accept(input);
    const b = runs.accept({ ...input, sourceEventId: "source-b" });
    const start = { key: "start", type: "run_started" as const, status: "running" as const, attemptId: "attempt-1" };
    const event = runs.append(a.id, start);
    expect(event).toMatchObject({ seq: 2, cursor: 3 });
    expect(runs.append(a.id, start)).toEqual(event);
    expect(() => runs.append(a.id, { ...start, attemptId: "other" })).toThrow("idempotency conflict");
    expect(runs.events(b.id)[0]).toMatchObject({ seq: 1, cursor: 2 });
    expect(runs.stream(1).map((item) => item.cursor)).toEqual([2, 3]);
    expect(runs.highWaterMark()).toBe(3);
  });

  it("写入事件失败时投影和游标一起回滚", () => {
    const { path, runs } = open();
    const run = runs.accept(input);
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TRIGGER reject_projection BEFORE UPDATE ON run_traces BEGIN SELECT RAISE(ABORT, 'disk fault'); END"
      );
      expect(() => runs.append(run.id, { key: "start", type: "run_started", status: "running" })).toThrow("disk fault");
      expect(runs.get(run.id)).toEqual(run);
      expect(runs.events(run.id)).toHaveLength(1);
      expect(runs.highWaterMark()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("终态不可改写，已提交事件仍可幂等读取", () => {
    const { runs } = open();
    const run = runs.accept(input);
    runs.append(run.id, { key: "start", type: "run_started", status: "running" });
    const terminal = { key: "done", type: "run_succeeded" as const, status: "succeeded" as const };
    const done = runs.append(run.id, terminal);
    expect(runs.append(run.id, terminal)).toEqual(done);
    expect(() => runs.append(run.id, { key: "again", type: "run_started", status: "running" })).toThrow("terminal");
    expect(runs.get(run.id)?.finishedAt).toBeDefined();
  });

  it("分页不受运行更新影响，参数非法时不执行无界查询", () => {
    const { runs } = open();
    const a = runs.accept(input);
    const b = runs.accept({ ...input, sourceEventId: "source-b" });
    const first = runs.list({ limit: 1 });
    expect(first.items[0]?.id).toBe(b.id);
    runs.append(a.id, { key: "start", type: "run_started", status: "running" });
    expect(runs.list({ before: first.nextCursor!, limit: 1 }).items[0]?.id).toBe(a.id);
    expect(runs.list({ status: "running" }).items.map((run) => run.id)).toEqual([a.id]);
    expect(() => runs.list({ limit: 201 })).toThrow();
    expect(() => runs.events(a.id, -1)).toThrow();
    expect(() => runs.stream(Number.NaN)).toThrow();
    expect(() => runs.list({ since: "bad-date" })).toThrow();
  });

  it("关闭重开保留事件且恢复区分中断与未知副作用", () => {
    const { store, path, runs } = open();
    const a = runs.accept(input);
    const b = runs.accept({ ...input, sourceEventId: "source-b" });
    runs.append(b.id, { key: "start", type: "run_started", status: "running" });
    runs.append(b.id, { key: "tool", type: "tool_call_started", data: { callId: "call-1" } });
    store.close();
    const reopened = new SqliteRuntimeContextStore({ databasePath: path });
    onTestFinished(() => reopened.close());
    reopened.runs.recover();
    expect(reopened.runs.get(a.id)?.status).toBe("interrupted");
    expect(reopened.runs.get(b.id)?.status).toBe("uncertain");
    const cursor = reopened.runs.highWaterMark();
    reopened.runs.recover();
    expect(reopened.runs.highWaterMark()).toBe(cursor);
    reopened.runs.append(a.id, { key: "resume", type: "run_resumed", status: "running" });
    expect(reopened.runs.get(a.id)?.finishedAt).toBeUndefined();
    expect(() => reopened.runs.append(b.id, { key: "resume", type: "run_resumed", status: "running" })).toThrow(
      "terminal"
    );
  });

  it("已结束工具不被误判为未决，不同调用分别配对", () => {
    const { runs } = open();
    const run = runs.accept(input);
    runs.append(run.id, { key: "start", type: "run_started", status: "running" });
    runs.append(run.id, { key: "tool-start", type: "tool_call_started", data: { callId: "call-1" } });
    runs.append(run.id, { key: "tool-end", type: "tool_call_succeeded", data: { callId: "call-1" } });
    runs.recover();
    expect(runs.get(run.id)?.status).toBe("interrupted");
  });

  it("秘密在持久化之前脱敏，二进制和大对象受限", () => {
    const { store, runs, path } = open();
    const run = runs.accept({ ...input, summary: "canary-secret-2874" });
    runs.append(run.id, { key: "start", type: "run_started", status: "running" });
    runs.append(run.id, {
      key: "model",
      type: "model_call_started",
      data: {
        authorization: "Bearer hidden-value",
        nested: { apiKey: "private-value" },
        content: "canary-secret-2874",
        bytes: Buffer.from("binary-secret")
      }
    });
    const value = JSON.stringify(runs.events(run.id));
    for (const secret of ["hidden-value", "private-value", "canary-secret-2874", "binary-secret"])
      expect(value).not.toContain(secret);
    store.close();
    expect(readFileSync(path).includes(Buffer.from("canary-secret-2874"))).toBe(false);
    expect(JSON.stringify(redactTrace({ content: "x".repeat(100_000) })).length).toBeLessThan(13_000);
    expect(redactTrace({ url: "https://example.test/?token=secret-value&ok=1" })).toEqual({
      url: "https://example.test/?token=[REDACTED]&ok=1"
    });
  });

  it("扩展迁移失败回滚，未来版本拒绝且不修改原数据", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE run_events (unexpected TEXT)");
      expect(() => new SqliteRunTraceStore(db)).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_traces'").get()).toBeUndefined();
      db.exec(
        "DROP TABLE run_events; CREATE TABLE run_trace_migrations (version INTEGER PRIMARY KEY); INSERT INTO run_trace_migrations VALUES (99)"
      );
      expect(() => new SqliteRunTraceStore(db)).toThrow("Unsupported");
      expect(db.prepare("SELECT version FROM run_trace_migrations").get()).toEqual({ version: 99 });
    } finally {
      db.close();
    }
  });
});
