import { useCallback, useEffect, useRef, useState } from "react";
import { type RunStatus, type RunQuery } from "@synapse/runtime-client";
import { STATUS_LABELS, time } from "../../shared/lib/runtime.js";
import { Badge, Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { Icon } from "../../shared/ui/icons.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { type ViewProps } from "../../shared/types/runtime.js";
import { RunDetail } from "./run-detail-page.js";
import { durationLabel, runDuration, shortTime } from "./run-presentation.js";
import { useRunsRefresh } from "./use-runs-refresh.js";
import "./runs.css";

const PAGE_SIZE = 12;

/** 在紧凑侧栏中筛选与分页，自动更新时保留页码、所选运行与详情滚动位置 */
export function Runs({ client, revision }: ViewProps) {
  const [query, setQuery] = useState<RunQuery>(readQuery);
  const [status, setStatus] = useState<RunStatus | "">(query.status ?? "");
  const [channelId, setChannel] = useState(query.channelId ?? "");
  const [sessionId, setSession] = useState(query.sessionId ?? "");
  const [since, setSince] = useState(localDateTime(query.since));
  const [until, setUntil] = useState(localDateTime(query.until));
  const [range, setRange] = useState("");
  const [search, setSearch] = useState(query.q ?? "");
  const [cursors, setCursors] = useState<number[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const searchRef = useRef<HTMLInputElement>(null);
  const filtersRef = useRef<HTMLDetailsElement>(null);
  const refresh = useRunsRefresh(revision);
  const before = cursors.at(-1);
  const load = useCallback(
    () => client.runs({ ...query, ...(before === undefined ? {} : { before }), limit: PAGE_SIZE }),
    [client, query, before]
  );
  const data = useLoad(load, refresh);
  const items = data.value?.items ?? [];
  const selectedId = selected || items[0]?.id;
  useEffect(() => {
    if (!selected && items[0]) setSelected(items[0].id);
  }, [selected, items]);
  const filterCount = [query.status, query.channelId, query.sessionId, query.since || query.until].filter(
    Boolean
  ).length;

  const apply = useCallback((next: RunQuery) => {
    setQuery(next);
    setCursors([]);
    setSelected("");
    setError("");
    const params = new URLSearchParams(
      Object.entries(next).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])
      )
    );
    // 更新可分享地址但不触发路由重挂载，保留搜索焦点与展开状态
    history.replaceState(history.state, "", `#/runs${params.size ? `?${params}` : ""}`);
  }, []);

  useEffect(() => {
    const navigate = () => {
      if (location.hash.split("?")[0] !== "#/runs") return;
      const next = readQuery();
      apply(next);
      setSearch(next.q ?? "");
      setStatus(next.status ?? "");
      setChannel(next.channelId ?? "");
      setSession(next.sessionId ?? "");
      setSince(localDateTime(next.since));
      setUntil(localDateTime(next.until));
      setRange("");
    };
    addEventListener("hashchange", navigate);
    return () => removeEventListener("hashchange", navigate);
  }, [apply]);

  useEffect(() => {
    if (search.trim() === (query.q ?? "")) return;
    const timer = setTimeout(() => apply({ ...query, q: search.trim() }), 300);
    return () => clearTimeout(timer);
  }, [search, query, apply]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    addEventListener("keydown", focusSearch);
    return () => {
      clearInterval(timer);
      removeEventListener("keydown", focusSearch);
    };
  }, []);

  const reset = () => {
    setStatus("");
    setChannel("");
    setSession("");
    setSince("");
    setUntil("");
    setRange("");
    setSearch("");
    apply({});
    if (filtersRef.current) filtersRef.current.open = false;
  };

  return (
    <div className="runs-page">
      <h1 className="sr-only">运行</h1>
      <div className="runs-layout">
        <section className="runs-list panel" aria-label="运行列表">
          <div className="runs-list-heading">
            <span>运行记录</span>
            <span
              className={`runs-live ${navigator.onLine ? "" : "offline"}`}
              title="运行事件实时更新，前台每 30 秒补读，返回页面时同步"
            >
              <span className="dot" />
              {navigator.onLine ? "自动更新" : "等待连接"}
            </span>
          </div>
          <label className="runs-search">
            <Icon name="search" />
            <span className="sr-only">搜索运行</span>
            <input
              ref={searchRef}
              type="search"
              maxLength={2048}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务、会话或运行 ID…"
            />
            <kbd title="Ctrl / ⌘ + K">⌘ K</kbd>
          </label>
          <details className="runs-filter-panel" ref={filtersRef}>
            <summary>
              筛选{filterCount ? ` · ${filterCount}` : ""}
              <span>状态 · 频道 · 时间</span>
            </summary>
            <form
              className="runs-filters"
              onSubmit={(event) => {
                event.preventDefault();
                if (since && until && Date.parse(since) > Date.parse(until)) {
                  setError("开始时间不能晚于结束时间");
                  return;
                }
                apply({
                  ...(search.trim() ? { q: search.trim() } : {}),
                  ...(status ? { status } : {}),
                  ...(channelId.trim() ? { channelId: channelId.trim() } : {}),
                  ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
                  ...(since ? { since: new Date(since).toISOString() } : {}),
                  ...(until ? { until: new Date(until).toISOString() } : {})
                });
                if (filtersRef.current) filtersRef.current.open = false;
              }}
            >
              <label>
                状态
                <select value={status} onChange={(event) => setStatus(event.target.value as RunStatus | "")}>
                  <option value="">全部状态</option>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                频道
                <input
                  value={channelId}
                  onChange={(event) => setChannel(event.target.value)}
                  placeholder="全部频道"
                  list="runs-channels"
                />
                <datalist id="runs-channels">
                  {[...new Set(items.map((run) => run.channelId))].map((channel) => (
                    <option key={channel} value={channel} />
                  ))}
                </datalist>
              </label>
              <label>
                时间范围
                <select
                  value={range}
                  onChange={(event) => {
                    setRange(event.target.value);
                    setSince(
                      event.target.value
                        ? localDateTime(new Date(Date.now() - Number(event.target.value) * 86400000).toISOString())
                        : ""
                    );
                    setUntil("");
                  }}
                >
                  <option value="">{since || until ? "自定义时间" : "全部时间"}</option>
                  <option value="1">最近 24 小时</option>
                  <option value="7">最近 7 天</option>
                  <option value="30">最近 30 天</option>
                </select>
              </label>
              <label>
                会话
                <input value={sessionId} onChange={(event) => setSession(event.target.value)} placeholder="全部会话" />
              </label>
              <label className="runs-filter-wide">
                开始时间
                <input
                  type="datetime-local"
                  value={since}
                  onChange={(event) => {
                    setSince(event.target.value);
                    setRange("");
                  }}
                />
              </label>
              <label className="runs-filter-wide">
                结束时间
                <input
                  type="datetime-local"
                  value={until}
                  onChange={(event) => {
                    setUntil(event.target.value);
                    setRange("");
                  }}
                />
              </label>
              <div className="runs-filter-actions">
                <button type="button" onClick={reset}>
                  重置
                </button>
                <button type="submit" className="primary">
                  应用筛选
                </button>
              </div>
            </form>
          </details>
          <ErrorNotice error={data.error || error} retry={data.reload} />
          <div className="runs-rows" key={before ?? "first"} aria-busy={data.loading}>
            {data.loading && !data.value ? (
              <Loading />
            ) : items.length ? (
              items.map((run) => (
                <a
                  key={run.id}
                  href={`#/runs/${encodeURIComponent(run.id)}`}
                  aria-label={run.summary || "无文本请求"}
                  className={`runs-row ${selectedId === run.id ? "selected" : ""}`}
                  aria-current={selectedId === run.id ? "true" : undefined}
                  onClick={(event) => {
                    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
                      event.preventDefault();
                      setSelected(run.id);
                    }
                  }}
                >
                  <strong className="runs-row-name" title={run.summary}>
                    {run.summary || "无文本请求"}
                  </strong>
                  <Badge status={run.status} />
                  <span className="runs-row-meta">
                    <time title={time(run.startedAt)} dateTime={run.startedAt}>
                      {shortTime(run.startedAt)}
                    </time>
                    <span>{run.channelId}</span>
                    <span className="runs-row-duration">{durationLabel(runDuration(run, now))}</span>
                  </span>
                </a>
              ))
            ) : (
              <Empty
                title="暂无运行记录"
                text={
                  query.q || filterCount ? "尝试其他关键词，或调整筛选条件" : "发送消息后，运行记录会自动出现在这里"
                }
              />
            )}
          </div>
          <div className="runs-pagination" aria-label="运行记录分页">
            <span>
              第 {cursors.length + 1} 页 · {items.length} 条
            </span>
            <div>
              <button
                aria-label="上一页"
                disabled={!cursors.length || data.loading}
                onClick={() => {
                  setCursors((value) => value.slice(0, -1));
                  setSelected("");
                }}
              >
                上一页
              </button>
              <button
                aria-label="下一页"
                disabled={data.value?.nextCursor === undefined || data.loading}
                onClick={() => {
                  if (data.value?.nextCursor === undefined) return;
                  setCursors((value) => [...value, data.value!.nextCursor!]);
                  setSelected("");
                }}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
        <section className="runs-detail panel" aria-label="选中运行详情">
          {selectedId ? (
            <RunDetail key={selectedId} client={client} revision={refresh} id={selectedId} embedded />
          ) : (
            <Empty title="选择一条运行记录" text="在这里查看执行时间线、上下文和工具调用" />
          )}
        </section>
      </div>
    </div>
  );
}

function localDateTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function readQuery(): RunQuery {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  return Object.fromEntries(
    ["q", "status", "channelId", "sessionId", "since", "until"].flatMap((key) =>
      params.get(key) ? [[key, params.get(key)!]] : []
    )
  ) as RunQuery;
}
