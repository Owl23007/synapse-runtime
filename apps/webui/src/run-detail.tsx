import { useCallback, useEffect, useState } from "react";
import type { RunEvent } from "@synapse/runtime-client";
import { Badge, Empty, ErrorNotice, Json, Loading, PageTitle, message, useLoad, type ViewProps } from "./app.js";
import { eventLabel, mergeEvents, record, time } from "./model.js";

/** 运行详情只呈现持久状态与执行时快照，不提供不安全的重放操作 */
export function RunDetail({ client, id, revision }: ViewProps & { readonly id: string }) {
  const load = useCallback(() => client.run(id), [client, id]);
  const data = useLoad(load, revision);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selected, setSelected] = useState<number>();
  const [tab, setTab] = useState("timeline");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextSeq, setNextSeq] = useState(0);
  const [refresh, setRefresh] = useState(0);
  // 逐页补读而非无界抓取，实时更新始终从已完成的连续序号接续
  useEffect(() => {
    let active = true;
    setBusy(true);
    void client
      .runEvents(id, nextSeq, 200)
      .then((page) => {
        if (!active) return;
        setEvents((current) => mergeEvents(id, current, page.events));
        setHasMore(page.hasMore);
        setError("");
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, id, nextSeq, revision, refresh]);
  const contextLoad = useCallback(() => client.runContext(id), [client, id]);
  const run = data.value?.run;
  const event = events.find((item) => item.seq === selected) ?? events.at(-1);
  if (!run)
    return (
      <>
        <ErrorNotice error={data.error} retry={data.reload} />
        {data.loading && <Loading />}
      </>
    );
  const guidance: Partial<Record<typeof run.status, string>> = {
    uncertain: "外部操作已发起，但尚无可靠回执。请检查平台消息或文件是否已送达，再人工决定后续处理；系统不会自动重放。",
    interrupted: "执行被中断。当前记录没有未决外部操作，保留的检查点可供排查；此页面不提供自动续跑。",
    blocked: "所需权限或频道能力未满足。检查权限判定和交付事件，调整配置后再发起新请求。",
    failed: "执行已确认失败。检查失败阶段及错误详情，处理原因后再发起新请求。"
  };
  return (
    <>
      <a className="back-link" href="#/runs">
        ← 运行记录
      </a>
      <PageTitle
        eyebrow="RUN INSPECTOR"
        title={run.summary || "运行详情"}
        description={run.id}
        action={<Badge status={run.status} />}
      />
      <ErrorNotice
        error={data.error || error}
        retry={() => {
          data.reload();
          setRefresh((v) => v + 1);
        }}
      />
      {guidance[run.status] && <div className="notice">{guidance[run.status]}</div>}
      <div className="metadata">
        <div>
          <span>频道</span>
          <strong>{run.channelId}</strong>
        </div>
        <div>
          <span>开始时间</span>
          <strong>{time(run.startedAt)}</strong>
        </div>
        <div>
          <span>结束时间</span>
          <strong>{run.finishedAt ? time(run.finishedAt) : "尚未结束"}</strong>
        </div>
        <div>
          <span>会话</span>
          <a href={`#/explorer?session=${encodeURIComponent(run.sessionId)}`}>{run.sessionId} ↗</a>
        </div>
      </div>
      {run.error && (
        <div className="notice error">
          <strong>{run.error.code}</strong>
          <span>{run.error.message}</span>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="运行详情">
        {[
          ["timeline", "执行时间线"],
          ["context", "上下文快照"],
          ["delivery", "交付记录"]
        ].map(([value, label]) => (
          <button role="tab" aria-selected={tab === value} key={value} onClick={() => setTab(value!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "context" ? (
        <Context load={contextLoad} revision={revision} />
      ) : (
        <section className="inspector panel">
          <div className="timeline">
            <div className="panel-heading">
              <h2>{tab === "delivery" ? "交付事件" : "执行事件"}</h2>
              <span className="muted">
                {events.length} / {run.lastSeq}
              </span>
            </div>
            {events
              .filter((item) => tab !== "delivery" || /artifact|response/.test(item.type))
              .map((item) => (
                <button
                  className={`event ${event?.seq === item.seq ? "selected" : ""}`}
                  key={item.id}
                  onClick={() => setSelected(item.seq)}
                >
                  <span className="event-index">{String(item.seq).padStart(2, "0")}</span>
                  <span>
                    <strong>{eventLabel(item.type)}</strong>
                    <small>{time(item.occurredAt)}</small>
                  </span>
                  <span className="event-duration">{item.durationMs === undefined ? "" : `${item.durationMs} ms`}</span>
                </button>
              ))}
            {!events.length && !busy && <Empty title="暂无事件" text="事件会在执行过程中持续记录" />}
            {hasMore && (
              <div className="load-more">
                <button disabled={busy} onClick={() => setNextSeq(events.at(-1)?.seq ?? 0)}>
                  加载后续事件
                </button>
              </div>
            )}
            {busy && <Loading />}
          </div>
          <div className="event-detail">
            {event ? (
              <>
                <span className="eyebrow">EVENT {event.seq}</span>
                <h2>{eventLabel(event.type)}</h2>
                <dl className="detail-facts">
                  <dt>事件类型</dt>
                  <dd>{event.type}</dd>
                  <dt>发生时间</dt>
                  <dd>{time(event.occurredAt)}</dd>
                  <dt>执行尝试</dt>
                  <dd>{event.attemptId ?? "未记录"}</dd>
                  <dt>耗时</dt>
                  <dd>{event.durationMs === undefined ? "未记录" : `${event.durationMs} ms`}</dd>
                </dl>
                <h3>记录内容</h3>
                <Json value={event.data} />
                <p className="hint">内容已按服务端策略脱敏与限长。缺失的 usage、耗时或历史字段表示未记录，不代表零。</p>
              </>
            ) : (
              <Empty title="选择一个事件" text="检查模型输入输出、工具参数和执行结果" />
            )}
          </div>
        </section>
      )}
    </>
  );
}
function Context({ load, revision }: { load: () => Promise<unknown>; revision: number }) {
  const data = useLoad(load, revision);
  const context = record(data.value);
  return (
    <section className="panel padded">
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading && !data.value ? (
        <Loading />
      ) : context.available ? (
        <>
          <h2>本次执行实际使用的上下文</h2>
          <p className="muted">此快照在执行时保存，后续引用变动不会改变这里的内容。</p>
          <Json value={context.snapshot} />
        </>
      ) : (
        <Empty title="没有可用的上下文快照" text="运行尚未解析上下文，或此历史记录创建时尚未启用追踪" />
      )}
    </section>
  );
}
