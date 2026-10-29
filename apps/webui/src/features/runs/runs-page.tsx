import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type RunTrace, type RunStatus, type RunQuery } from "@synapse/runtime-client";
import { STATUS_LABELS, message, time } from "../../shared/lib/runtime.js";
import { Badge, Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { PageTitle } from "../../shared/ui/content.js";
import { Icon } from "../../shared/ui/icons.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { type ViewProps } from "../../shared/types/runtime.js";
import { RunDetail } from "./run-detail-page.js";
import { durationLabel, runDuration, shortTime } from "./run-presentation.js";
import "./runs.css";

/** 保留 URL 筛选与游标分页，在同页选择运行并检查执行详情 */
export function Runs({ client, revision }: ViewProps) {
  const [params] = useState(() => new URLSearchParams(location.hash.split("?")[1]));
  const [query] = useState<RunQuery>(
    () =>
      Object.fromEntries(
        ["status", "channelId", "sessionId", "since", "until"].flatMap((key) =>
          params.get(key) ? [[key, params.get(key)!]] : []
        )
      ) as RunQuery
  );
  const [status, setStatus] = useState(query.status ?? "");
  const [channelId, setChannel] = useState(query.channelId ?? "");
  const [sessionId, setSession] = useState(query.sessionId ?? "");
  const [since, setSince] = useState(localDateTime(query.since));
  const [until, setUntil] = useState(localDateTime(query.until));
  const [range, setRange] = useState("");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [ascending, setAscending] = useState(false);
  const [selected, setSelected] = useState("");
  const [older, setOlder] = useState<RunTrace[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const searchRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => client.runs(query), [client, query]);
  const data = useLoad(load, revision);
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
  const items = useMemo(
    () => [...new Map([...(data.value?.items ?? []), ...older].map((run) => [run.id, run])).values()],
    [data.value, older]
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items
      .filter((run) => `${run.id} ${run.summary} ${run.sessionId}`.toLocaleLowerCase().includes(needle))
      .toSorted((a, b) => (Date.parse(a.startedAt) - Date.parse(b.startedAt)) * (ascending ? 1 : -1));
  }, [items, search, ascending]);
  const selectedRun = visible.find((run) => run.id === selected) ?? visible[0];
  useEffect(() => {
    if (selectedRun && selectedRun.id !== selected) setSelected(selectedRun.id);
  }, [selectedRun, selected]);
  const next = cursor ?? data.value?.nextCursor;
  const more = async () => {
    if (next === undefined || busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await client.runs({ ...query, before: next });
      setOlder((value) => [...value, ...page.items]);
      setCursor(page.nextCursor ?? 0);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="runs-page">
      <PageTitle
        title="运行记录"
        description="查看和调试所有任务的执行运行"
        action={
          <button
            className="icon-button"
            aria-label="刷新记录"
            title="刷新记录"
            onClick={() => {
              data.reload();
              setRefresh((value) => value + 1);
            }}
          >
            <Icon name="refresh" />
          </button>
        }
      />
      <form
        className="runs-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (since && until && Date.parse(since) > Date.parse(until)) {
            setError("开始时间不能晚于结束时间");
            return;
          }
          const nextQuery = {
            ...(status ? { status } : {}),
            ...(channelId.trim() ? { channelId: channelId.trim() } : {}),
            ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
            ...(since ? { since: new Date(since).toISOString() } : {}),
            ...(until ? { until: new Date(until).toISOString() } : {}),
            ...(search.trim() ? { q: search.trim() } : {})
          };
          setError("");
          location.hash = `/runs?${new URLSearchParams(nextQuery)}`;
        }}
      >
        <label className="runs-search">
          <Icon name="search" />
          <span className="sr-only">搜索运行</span>
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 run id、任务名称或会话…"
          />
          <kbd title="Ctrl / ⌘ + K">⌘ K</kbd>
        </label>
        <label>
          状态
          <select
            aria-label="状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as RunStatus | "")}
          >
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
        <button type="submit">筛选</button>
        <details className="runs-advanced">
          <summary>更多筛选</summary>
          <div>
            <label>
              会话
              <input value={sessionId} onChange={(event) => setSession(event.target.value)} placeholder="会话 ID" />
            </label>
            <label>
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
            <label>
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
            <a href="#/runs">重置筛选</a>
          </div>
        </details>
      </form>
      <ErrorNotice error={data.error || error} retry={data.reload} />
      <div className={`runs-layout ${selectedRun ? "has-selection" : ""}`}>
        <section className="runs-list panel" aria-label="运行列表">
          <div className="runs-list-heading">
            <span>
              {search ? `匹配 ${visible.length} 条 / 已加载 ${items.length} 条` : `已加载 ${items.length} 条记录`}
            </span>
            <button
              onClick={() => setAscending((value) => !value)}
              aria-label={ascending ? "按开始时间降序" : "按开始时间升序"}
            >
              开始时间 {ascending ? "↑" : "↓"}
            </button>
          </div>
          {data.loading && !data.value ? (
            <Loading />
          ) : visible.length ? (
            <div className="runs-rows">
              {visible.map((run) => (
                <a
                  key={run.id}
                  href={`#/runs/${encodeURIComponent(run.id)}`}
                  aria-label={run.summary || "无文本请求"}
                  className={`runs-row ${selectedRun?.id === run.id ? "selected" : ""}`}
                  aria-current={selectedRun?.id === run.id ? "true" : undefined}
                  onClick={(event) => {
                    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
                      event.preventDefault();
                      setSelected(run.id);
                    }
                  }}
                >
                  <span className="runs-row-icon">
                    <Icon name="run" />
                  </span>
                  <span className="runs-row-name">
                    <strong title={run.summary}>{run.summary || "无文本请求"}</strong>
                    <code title={run.id}>{run.id}</code>
                  </span>
                  <Badge status={run.status} />
                  <time title={time(run.startedAt)} dateTime={run.startedAt}>
                    {shortTime(run.startedAt)}
                  </time>
                  <span className="runs-row-duration">{durationLabel(runDuration(run, now))}</span>
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="暂无运行记录"
              text={search ? "尝试其他关键词，或加载更早记录继续搜索" : "发送消息开始运行，或调整筛选条件"}
            />
          )}
          {next !== undefined && next > 0 && (
            <div className="load-more">
              <button disabled={busy} onClick={() => void more()}>
                {busy ? "加载中…" : "加载更早记录"}
              </button>
            </div>
          )}
          <div className="runs-list-footer">{next ? "搜索与排序作用于已加载记录" : "已显示全部已加载记录"}</div>
        </section>
        <section className="runs-detail panel" aria-label="选中运行详情">
          {selectedRun ? (
            <RunDetail
              key={selectedRun.id}
              client={client}
              revision={revision + refresh}
              id={selectedRun.id}
              embedded
            />
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
