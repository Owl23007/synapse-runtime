import { useCallback, useEffect, useRef, useState } from "react";
import { type RunEvent } from "@synapse/runtime-client";
import { navigateTabs } from "../../shared/ui/tabs.js";
import { Badge, Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { Json, PageTitle } from "../../shared/ui/content.js";
import { message, eventLabel, mergeEvents, record, time } from "../../shared/lib/runtime.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { type ViewProps } from "../../shared/types/runtime.js";
import { Icon } from "../../shared/ui/icons.js";
import { ExecutionChart, ToolCalls } from "./run-activity.js";
import { durationLabel, runDuration, shortTime } from "./run-presentation.js";
import "./runs.css";

/** 以请求内容为标题检查持久状态，执行事件在卡片内分栏浏览并独立滚动 */
export function RunDetail({
  client,
  id,
  revision,
  embedded = false
}: ViewProps & { readonly id: string; readonly embedded?: boolean }) {
  const load = useCallback(() => client.run(id), [client, id]);
  const data = useLoad(load, revision);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selected, setSelected] = useState<number>();
  const selectedEventRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState("timeline");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextSeq, setNextSeq] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [copyState, setCopyState] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // 逐页补读而非无界抓取，实时更新始终从已完成的连续序号接续
  useEffect(() => {
    let active = true;
    setBusy(true);
    void client
      .runEvents(id, nextSeq, 200)
      .then((page) => {
        if (!active) return undefined;
        setEvents((current) => mergeEvents(id, current, page.events));
        setHasMore(page.hasMore);
        setError("");
        return undefined;
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
  const dependenciesLoad = useCallback(async () => {
    const result = record(await client.runDependencies(id));
    return { available: result.snapshot !== null, snapshot: result.snapshot };
  }, [client, id]);
  const run = data.value?.run;
  const filteredEvents = events.filter((item) => tab !== "delivery" || /artifact|response/.test(item.type));
  const event = filteredEvents.find((item) => item.seq === selected) ?? filteredEvents.at(-1);
  useEffect(() => {
    const button = selectedEventRef.current;
    const list = button?.parentElement;
    if (!button || !list) return;
    // 只调整事件列表，避免 scrollIntoView 连带滚动外层页面或阶段图
    const bounds = button.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top;
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }, [event?.id, tab, run?.id]);
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
  const workspaceLink = run.sessionId
    ? `#/${run.channelId === "native" ? "workspace" : "explorer"}?session=${encodeURIComponent(run.sessionId)}`
    : undefined;
  return (
    <div className={`run-inspection ${embedded ? "embedded" : "standalone"}`}>
      {!embedded && (
        <a className="back-link" href="#/runs">
          ← 运行记录
        </a>
      )}
      {embedded ? (
        <>
          <div className="run-detail-heading">
            <span className="run-detail-symbol">
              <Icon name="run" />
            </span>
            <div className="run-detail-title">
              <div className="run-title-line">
                <h2 className="run-summary" title={run.summary}>
                  {run.summary || "无文本请求"}
                </h2>
                <Badge status={run.status} />
              </div>
              <div className="run-id-line">
                <a className="run-detail-id" href={`#/runs/${encodeURIComponent(run.id)}`} title={run.id}>
                  {run.id}
                </a>
                <button
                  className="icon-button"
                  aria-label="复制运行 ID"
                  title={copyState || "复制运行 ID"}
                  onClick={() => {
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(run.id))
                      .then(
                        () => setCopyState("已复制"),
                        () => setCopyState("复制失败，请手动复制运行 ID")
                      );
                  }}
                >
                  <Icon name={copyState === "已复制" ? "check" : "copy"} />
                </button>
              </div>
            </div>
            {workspaceLink && (
              <a className="button run-open-session" href={workspaceLink}>
                <Icon name="chat" />
                {run.channelId === "native" ? "在工作空间中打开" : "查看会话"}
              </a>
            )}
          </div>
          <span className="sr-only" role="status">
            {copyState}
          </span>
        </>
      ) : (
        <PageTitle title={run.summary || "运行详情"} description={run.id} action={<Badge status={run.status} />} />
      )}
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
          <span>
            <Icon name="clock" /> 开始时间
          </span>
          <strong>{time(run.startedAt)}</strong>
        </div>
        <div>
          <span>
            <Icon name="activity" /> 运行时长
          </span>
          <strong>
            {durationLabel(runDuration(run, now))}
            {["accepted", "running"].includes(run.status) ? "（进行中）" : ""}
          </strong>
        </div>
        <div>
          <span>
            <Icon name="folder" /> 频道
          </span>
          <strong>{run.channelId}</strong>
        </div>
        <div>
          <span>
            <Icon name="chat" /> 会话
          </span>
          {workspaceLink ? (
            <a href={workspaceLink}>{run.sessionId} ↗</a>
          ) : (
            <strong>后台运行 · {run.workspaceId}</strong>
          )}
        </div>
        {!embedded && (
          <div>
            <span>结束时间</span>
            <strong>{run.finishedAt ? time(run.finishedAt) : "尚未结束"}</strong>
          </div>
        )}
      </div>
      {run.error && (
        <div className="notice error">
          <strong>{run.error.code}</strong>
          <span>{run.error.message}</span>
        </div>
      )}
      <div className="tabs" role="tablist" onKeyDown={navigateTabs} aria-label="运行详情">
        {[
          ["timeline", "执行时间线"],
          ["context", "上下文快照"],
          ["dependencies", "资源与能力"],
          ["tools", "工具调用"],
          ["delivery", "交付记录"]
        ].map(([value, label]) => (
          <button
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            aria-selected={tab === value}
            id={`run-${id}-${value}-tab`}
            aria-controls={`run-${id}-panel`}
            key={value}
            onClick={() => setTab(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className={`run-tab-panel run-tab-${tab}`}
        role="tabpanel"
        id={`run-${id}-panel`}
        aria-labelledby={`run-${id}-${tab}-tab`}
      >
        {tab === "timeline" && <ExecutionChart run={run} events={events} now={now} hasMore={hasMore} />}
        {tab === "context" || tab === "dependencies" ? (
          <Context load={tab === "context" ? contextLoad : dependenciesLoad} revision={revision} />
        ) : tab === "tools" ? (
          <section className="panel padded">
            <ToolCalls events={events} />
            {hasMore && <p className="hint">当前仅展示已加载的事件，请在执行时间线中加载后续事件</p>}
          </section>
        ) : (
          <section className="run-event-inspector panel" aria-label={tab === "delivery" ? "交付事件" : "执行事件"}>
            <div className="panel-heading">
              <h2>{tab === "delivery" ? "交付事件" : "执行事件"}</h2>
              <span className="muted">
                {filteredEvents.length}
                {tab === "timeline" ? ` / ${run.lastSeq}` : ""}
              </span>
            </div>
            <div className="run-event-split">
              <div className="timeline" role="region" aria-label="事件列表" tabIndex={0}>
                {filteredEvents.map((item) => (
                  <button
                    className={`event ${event?.seq === item.seq ? "selected" : ""}`}
                    aria-pressed={event?.seq === item.seq}
                    ref={event?.seq === item.seq ? selectedEventRef : undefined}
                    key={item.id}
                    onClick={() => setSelected(item.seq)}
                  >
                    <span className="event-index">{String(item.seq).padStart(2, "0")}</span>
                    <span className="run-event-label">
                      <strong title={eventLabel(item.type)}>{eventLabel(item.type)}</strong>
                      <small>
                        <time title={time(item.occurredAt)} dateTime={item.occurredAt}>
                          {shortTime(item.occurredAt)}
                        </time>
                        {item.durationMs !== undefined && <span>{durationLabel(item.durationMs)}</span>}
                      </small>
                    </span>
                  </button>
                ))}
                {!filteredEvents.length && !busy && (
                  <Empty title={tab === "delivery" ? "暂无交付事件" : "暂无事件"} text="事件会在执行过程中持续记录" />
                )}
                {hasMore && (
                  <div className="load-more">
                    <button disabled={busy} onClick={() => setNextSeq(events.at(-1)?.seq ?? 0)}>
                      加载后续事件
                    </button>
                  </div>
                )}
                {busy && !events.length && <Loading />}
              </div>
              <div className="event-detail" key={event?.id ?? "empty"} role="region" aria-label="事件详情" tabIndex={0}>
                {event ? (
                  <>
                    <h2>{eventLabel(event.type)}</h2>
                    <dl className="detail-facts">
                      <dt>事件类型</dt>
                      <dd>{event.type}</dd>
                      <dt>发生时间</dt>
                      <dd>{time(event.occurredAt)}</dd>
                      <dt>执行尝试</dt>
                      <dd>{event.attemptId ?? "未记录"}</dd>
                      <dt>耗时</dt>
                      <dd>{durationLabel(event.durationMs)}</dd>
                    </dl>
                    <h3>记录内容</h3>
                    <Json value={event.data} />
                  </>
                ) : (
                  <Empty title="选择一个事件" text="检查模型输入输出、工具参数和执行结果" />
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
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
          <Json value={context.snapshot} />
        </>
      ) : (
        <Empty title="没有可用的上下文快照" text="运行尚未解析上下文，或此历史记录创建时尚未启用追踪" />
      )}
    </section>
  );
}
