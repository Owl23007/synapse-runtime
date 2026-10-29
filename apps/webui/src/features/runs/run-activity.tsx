import { type RunEvent, type RunTrace } from "@synapse/runtime-client";
import { Empty } from "../../shared/ui/feedback.js";
import { Icon } from "../../shared/ui/icons.js";
import { eventLabel, record } from "../../shared/lib/runtime.js";
import { durationLabel, runDuration } from "./run-presentation.js";

/** 仅绘制服务端记录了耗时的事件，避免把事件间隔误认为执行耗时 */
export function ExecutionChart({
  run,
  events,
  now,
  hasMore
}: {
  run: RunTrace;
  events: readonly RunEvent[];
  now: number;
  hasMore: boolean;
}) {
  const origin = Date.parse(run.startedAt);
  const measured = events.filter(
    (event) =>
      event.durationMs !== undefined &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0 &&
      Number.isFinite(origin) &&
      Number.isFinite(Date.parse(event.occurredAt))
  );
  const total = Math.max(
    1,
    runDuration(run, now) ?? 0,
    ...measured.map((event) => Date.parse(event.occurredAt) - origin)
  );
  return (
    <section className="run-chart panel">
      <div className="run-chart-heading">
        <h3>执行阶段</h3>
        <span>
          总耗时 <strong>{durationLabel(runDuration(run, now))}</strong>
        </span>
      </div>
      {measured.length ? (
        <div className="run-chart-content">
          <div className="run-chart-axis">
            <span />
            <div>
              {[0, 1, 2, 3, 4].map((tick) => (
                <span key={tick}>{((total * tick) / 4000).toFixed(1)}s</span>
              ))}
            </div>
          </div>
          {measured.map((event) => {
            const end = Math.max(0, Date.parse(event.occurredAt) - origin);
            const start = Math.max(0, end - event.durationMs!);
            return (
              <div className="run-chart-row" key={event.id}>
                <span title={eventLabel(event.type)}>{eventLabel(event.type)}</span>
                <div className="run-chart-track">
                  <span
                    className={`run-chart-bar ${event.type.startsWith("tool_") ? "tool" : ""}`}
                    style={{
                      left: `${(start / total) * 100}%`,
                      width: `${Math.max(0.8, ((end - start) / total) * 100)}%`
                    }}
                    title={`${eventLabel(event.type)} · ${durationLabel(event.durationMs)}`}
                  />
                  <span className="run-chart-duration">{durationLabel(event.durationMs)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="hint">尚无已记录耗时的阶段，可在下方事件日志中查看执行进度</p>
      )}
      {hasMore && <p className="hint">阶段图展示已加载事件，加载后续事件可查看更多阶段</p>}
    </section>
  );
}

/** 按尝试与调用标识归并工具回执，缺少回执时明确显示未确认 */
export function ToolCalls({ events, onSelect }: { events: readonly RunEvent[]; onSelect?: (seq: number) => void }) {
  const calls = new Map<string, RunEvent[]>();
  for (const event of events.filter((item) => item.type.startsWith("tool_call_"))) {
    const payload = record(event.data);
    const callId = typeof payload.callId === "string" ? payload.callId : event.id;
    const key = `${event.attemptId ?? ""}:${callId}`;
    calls.set(key, [...(calls.get(key) ?? []), event]);
  }
  return (
    <>
      <h3 className="run-tools-title">
        工具调用 <span className="count">{calls.size}</span>
      </h3>
      {calls.size ? (
        <div className="run-tool-list">
          {[...calls.entries()].map(([key, history], index) => {
            const last = history.at(-1)!;
            const first = history.find((event) => event.type === "tool_call_started");
            const payload = record(last.data);
            const name = typeof payload.name === "string" ? payload.name : "未记录工具名";
            const success = /succeeded|completed|replayed/.test(last.type);
            const failed = /failed|blocked/.test(last.type);
            const duration =
              last.durationMs ??
              (first && last !== first ? Date.parse(last.occurredAt) - Date.parse(first.occurredAt) : undefined);
            const content = (
              <>
                <span className="run-tool-index">{index + 1}</span>
                <span className="run-tool-name">
                  <strong>{name}</strong>
                  <small>{eventLabel(last.type)}</small>
                </span>
                <span className="run-tool-duration">{durationLabel(duration)}</span>
                <span
                  className={`run-tool-state ${success ? "success" : failed ? "failure" : "pending"}`}
                  title={success ? "已完成" : failed ? "失败或受阻" : "尚无结果回执"}
                >
                  <Icon name={success ? "check" : failed ? "close" : "clock"} />
                </span>
              </>
            );
            return onSelect ? (
              <button className="run-tool" key={key} onClick={() => onSelect(last.seq)}>
                {content}
              </button>
            ) : (
              <div className="run-tool" key={key}>
                {content}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty title="暂无工具调用" text="工具调用记录会在执行后显示" />
      )}
    </>
  );
}
