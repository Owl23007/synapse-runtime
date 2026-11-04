import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { RuntimeInspection, InspectionQueryError } from "../../../src/inspection/runtime-inspection.js";

function fixture() {
  const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
  onTestFinished(() => store.close());
  const inspection = new RuntimeInspection(store, {
    list: () => ({ items: [] }),
    describe: () => undefined,
    read: () => {
      throw new Error("No artifacts in this fixture");
    }
  });
  const accept = (sourceEventId: string, summary: string, channelId = "native", sessionId = "session") =>
    store.runs.accept({ sourceEventId, summary, channelId, sessionId });
  return { store, inspection, accept };
}

describe("运行关键词与游标分页", () => {
  it("先搜索完整历史再分页，新运行插入和状态变更不跳过较早匹配项", () => {
    const { store, inspection, accept } = fixture();
    const oldest = accept("oldest", "历史报告");
    accept("unrelated", "普通请求");
    const middle = accept("middle", "生成报告");
    const newest = accept("newest", "检查报告");
    const first = inspection.listRuns({ q: " 报告 ", limit: 2 });
    expect(first.items.map((run) => run.id)).toEqual([newest.id, middle.id]);
    expect(first.nextCursor).toBeDefined();
    accept("arrived", "最新报告");
    store.runs.append(middle.id, { key: "start", type: "run_started", status: "running" });
    const second = inspection.listRuns({ q: "报告", limit: 2, before: first.nextCursor! });
    expect(second.items.map((run) => run.id)).toEqual([oldest.id]);
    expect(second.nextCursor).toBeUndefined();
    expect(inspection.listRuns({ q: "报告", status: "running" }).items.map((run) => run.id)).toEqual([middle.id]);
  });

  it("支持运行 ID、中文摘要、会话和英文大小写，通配符仅匹配字面字符", () => {
    const { inspection, accept } = fixture();
    const report = accept("report", "Review REPORT 100%_done", "native", "session-unique");
    accept("other", "Review REPORT 100 percent done", "qq", "other-session");
    expect(inspection.listRuns({ q: report.id }).items.map((run) => run.id)).toEqual([report.id]);
    expect(inspection.listRuns({ q: "SESSION-UNIQUE" }).items.map((run) => run.id)).toEqual([report.id]);
    expect(inspection.listRuns({ q: "%_" }).items.map((run) => run.id)).toEqual([report.id]);
    expect(inspection.listRuns({ q: "report", channelId: "native" }).items.map((run) => run.id)).toEqual([report.id]);
    expect(inspection.listRuns({ q: "not-found" })).toEqual({ items: [] });
    expect(inspection.listRuns({ q: "   " }).items).toHaveLength(2);
  });

  it("限制搜索长度并允许没有会话的后台运行参与搜索", () => {
    const { store, inspection } = fixture();
    const run = store.runs.accept({
      sourceEventId: "background",
      channelId: "scheduler",
      workspaceId: "workspace",
      summary: "后台检查"
    });
    expect(inspection.listRuns({ q: "后台" }).items.map((item) => item.id)).toEqual([run.id]);
    expect(() => inspection.listRuns({ q: "x".repeat(2049) })).toThrow(InspectionQueryError);
    expect(inspection.listRuns({ q: "x".repeat(2048) }).items).toEqual([]);
  });
});
