import { useCallback, useEffect, useMemo, useState } from "react";
import { type RunTrace, type RunStatus, type RunQuery } from "@synapse/runtime-client";
import { STATUS_LABELS, message } from "../../shared/lib/runtime.js";
import { ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { PageTitle } from "../../shared/ui/content.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { type ViewProps } from "../../shared/types/runtime.js";
import { RunTable } from "./run-table.js";

/** 保留 URL 筛选与历史分页的运行列表 */
export function Runs({ client, revision }: ViewProps) {
  const [query] = useState<RunQuery>(() => {
    const params = new URLSearchParams(location.hash.split("?")[1]);
    const fields = Object.fromEntries(
      ["status", "channelId", "sessionId", "since", "until"].flatMap((key) =>
        params.get(key) ? [[key, params.get(key)!]] : []
      )
    );
    return fields as RunQuery;
  });
  const [status, setStatus] = useState<string>(query.status ?? "");
  const [channelId, setChannel] = useState(query.channelId ?? "");
  const [sessionId, setSession] = useState(query.sessionId ?? "");
  const [since, setSince] = useState(localDateTime(query.since));
  const [until, setUntil] = useState(localDateTime(query.until));
  const [older, setOlder] = useState<RunTrace[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => client.runs(query), [client, query]);
  const data = useLoad(load, revision);
  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
  }, [query]);
  const items = useMemo(
    () => [...new Map([...(data.value?.items ?? []), ...older].map((run) => [run.id, run])).values()],
    [data.value, older]
  );
  const next = cursor ?? data.value?.nextCursor;
  const more = async () => {
    if (next === undefined) return;
    setBusy(true);
    setError("");
    try {
      const page = await client.runs({ ...query, before: next });
      setOlder((v) => [...v, ...page.items]);
      setCursor(page.nextCursor ?? 0);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle title="运行记录" description="" action={<button onClick={data.reload}>刷新记录 ↻</button>} />
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          const nextQuery = {
            ...(status ? { status: status as RunStatus } : {}),
            ...(channelId ? { channelId } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(since ? { since: new Date(since).toISOString() } : {}),
            ...(until ? { until: new Date(until).toISOString() } : {})
          };
          location.hash = `/runs?${new URLSearchParams(nextQuery).toString()}`;
        }}
      >
        <label>
          状态
          <select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>
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
          <input value={channelId} onChange={(e) => setChannel(e.target.value)} placeholder="频道 ID" />
        </label>
        <label>
          会话
          <input value={sessionId} onChange={(e) => setSession(e.target.value)} placeholder="会话 ID" />
        </label>
        <label>
          开始时间
          <input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <label>
          结束时间
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <button className="primary">筛选</button>
      </form>
      <ErrorNotice error={data.error || error} retry={data.reload} />
      <section className="panel">
        {data.loading && !data.value ? <Loading /> : <RunTable runs={items} />}
        {next !== undefined && next > 0 && (
          <div className="load-more">
            <button disabled={busy} onClick={() => void more()}>
              {busy ? "加载中…" : "加载更早记录"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
function localDateTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
