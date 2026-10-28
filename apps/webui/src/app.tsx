import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  RuntimeAdminClient,
  type RunTrace,
  type RunStatus,
  type RunQuery,
  type RunStreamState
} from "@synapse/runtime-client";
import { STATUS_LABELS, normalizeEndpoint, record, time } from "./model.js";
import { RunDetail } from "./run-detail.js";
import { Explorer } from "./explorer.js";
import { Workspace } from "./workspace.js";
import { System } from "./system.js";
import { Badge, Empty, ErrorNotice, Loading, PageTitle, message, useLoad, type ViewProps } from "./ui.js";

/** Runtime 控制台入口，凭据只保存在当前页面内存 */
export function App() {
  const [connection, setConnection] = useState<{ client: RuntimeAdminClient; endpoint: string }>();
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  const [stream, setStream] = useState<RunStreamState>("connecting");
  const [revision, setRevision] = useState(0);
  const [lastSync, setLastSync] = useState<string>();
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (!connection) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: number | undefined;
    let stop = () => {};
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        setRevision((v) => v + 1);
        setLastSync(new Date().toISOString());
      }, 250);
    };
    const connect = () => {
      if (!navigator.onLine) {
        setStream("reconnecting");
        return;
      }
      stop();
      stop = connection.client.streamRuns({
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
        onEvent: (event) => {
          cursor = event.cursor;
          refresh();
        },
        onSnapshot: (snapshot) => {
          cursor ??= snapshot.cursor;
          refresh();
        },
        onReset: () => {
          cursor = undefined;
          refresh();
        },
        onState: setStream
      });
    };
    const offline = () => {
      stop();
      setStream("reconnecting");
    };
    addEventListener("online", connect);
    addEventListener("offline", offline);
    connect();
    return () => {
      removeEventListener("online", connect);
      removeEventListener("offline", offline);
      stop();
      clearTimeout(timer);
    };
  }, [connection]);
  if (!connection) return <Connect onConnect={(client, endpoint) => setConnection({ client, endpoint })} />;
  const section = route.split("?")[0]!.split("/")[1] || "overview";
  const id = route.split("/")[2];
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-icon">S</span>
          <span>
            synapse<small>RUNTIME CONSOLE</small>
          </span>
        </a>
        <div className="workspace">
          <span className={`dot ${stream === "connected" ? "live" : ""}`} />
          <span>
            Runtime <small>{new URL(connection.endpoint).host}</small>
          </span>
        </div>
        <span className="nav-label">工作空间</span>
        <nav aria-label="主导航">
          {[
            ["workspace", "⌘", "会话工作台", "/workspace"],
            ["overview", "◈", "总览", "/"],
            ["runs", "↗", "运行记录", "/runs"],
            ["explorer", "◇", "数据浏览", "/explorer"],
            ["system", "≡", "系统状态", "/system"]
          ].map(([key, icon, label, path]) => (
            <a key={key} aria-current={section === key ? "page" : undefined} href={`#${path}`}>
              <span aria-hidden="true">{icon}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="version">v0.1 · 开发版</span>
          <button className="text-button" onClick={() => setConnection(undefined)}>
            断开连接 ↗
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            工作空间 <span className="separator">/</span>{" "}
            {(
              {
                workspace: "会话工作台",
                overview: "总览",
                runs: "运行记录",
                explorer: "数据浏览",
                system: "系统状态"
              } as Record<string, string>
            )[section] ?? "页面"}
          </span>
          <span role="status" className={`connection ${stream === "connected" ? "online" : ""}`}>
            {stream !== "connected" && lastSync && <small>更新于 {time(lastSync)}</small>}
            <span className="dot" />
            <span>
              {
                {
                  connecting: "连接中",
                  connected: "实时连接",
                  reconnecting: "正在重连",
                  unauthorized: "认证已失效",
                  incompatible: "版本不兼容",
                  stopped: "已断开"
                }[stream]
              }
            </span>
          </span>
        </header>
        {(stream === "unauthorized" || stream === "incompatible") && (
          <div className="notice error" role="alert">
            {stream === "unauthorized"
              ? "认证失败，请断开连接后重新输入凭据"
              : "服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本"}
          </div>
        )}
        <main>
          {section === "workspace" ? (
            <Workspace
              key={route}
              client={connection.client}
              revision={revision}
              initialSession={new URLSearchParams(route.split("?")[1]).get("session") ?? ""}
              initialLine={new URLSearchParams(route.split("?")[1]).get("line") ?? ""}
            />
          ) : section === "overview" ? (
            <Overview client={connection.client} revision={revision} />
          ) : section === "runs" ? (
            id ? (
              <RunDetail key={id} client={connection.client} id={id} revision={revision} />
            ) : (
              <Runs key={route} client={connection.client} revision={revision} />
            )
          ) : section === "explorer" ? (
            <Explorer
              key={route}
              client={connection.client}
              initialSession={new URLSearchParams(route.split("?")[1]).get("session") ?? ""}
            />
          ) : section === "system" ? (
            <System client={connection.client} />
          ) : (
            <Empty title="页面不存在" text="从左侧导航选择一个页面" />
          )}
        </main>
      </div>
    </div>
  );
}

function Connect({ onConnect }: { onConnect: (client: RuntimeAdminClient, endpoint: string) => void }) {
  const [endpoint, setEndpoint] = useState(location.origin);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const normalized = normalizeEndpoint(endpoint);
      if (normalized !== location.origin) throw new Error("请先在浏览器中打开目标 Runtime 的管理地址，再连接该服务");
      const client = new RuntimeAdminClient({ endpoint: normalized, ...(token ? { token } : {}) });
      const status = record(await client.status());
      if (status.protocolVersion !== 1) throw new Error("服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本");
      onConnect(client, normalized);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connect-page">
      <div className="connect-story">
        <a href="#/" className="brand">
          <span className="brand-icon">S</span>
          <span>
            synapse<small>RUNTIME CONSOLE</small>
          </span>
        </a>
        <div>
          <span className="eyebrow">SYNAPSE WORKSPACE</span>
          <h1>
            思考。执行。
            <br />
            探索新的分支。
          </h1>
          <div className="connect-graph" aria-hidden="true">
            <span>输入</span>
            <i />
            <span>Agent</span>
            <i />
            <span>结果</span>
          </div>
        </div>
        <small>Synapse Runtime / 0.1 开发版</small>
      </div>
      <div className="connect-form">
        <form onSubmit={submit}>
          <h2>连接 Runtime</h2>
          <label>
            服务地址
            <input
              required
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            访问令牌 <span className="muted">可选</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="输入 Admin Token"
            />
          </label>
          <p className="hint">令牌仅保留在内存中，刷新后清除</p>
          {error && <ErrorNotice error={error} />}
          <button className="primary full" disabled={busy}>
            {busy ? "正在连接…" : "连接工作空间 →"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Overview({ client, revision }: ViewProps) {
  const load = useCallback(() => client.runs({ limit: 50 }), [client]);
  const data = useLoad(load, revision);
  const runs = data.value?.items ?? [];
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE OVERVIEW"
        title="运行总览"
        description=""
        action={<button onClick={data.reload}>刷新</button>}
      />
      <ErrorNotice error={data.error} retry={data.reload} />
      <div className="metrics">
        {[
          ["最近运行", runs.length],
          ["执行中", runs.filter((r) => ["accepted", "running"].includes(r.status)).length],
          ["已完成", runs.filter((r) => r.status === "succeeded").length],
          ["需要关注", runs.filter((r) => ["failed", "blocked", "uncertain", "interrupted"].includes(r.status)).length]
        ].map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{data.loading && !data.value ? "—" : value}</strong>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>最近运行</h2>
          </div>
          <span className="subtle-label">LATEST ACTIVITY</span>
        </div>
        {data.loading && !data.value ? <Loading /> : <RunTable runs={runs.slice(0, 8)} />}
      </section>
    </>
  );
}

function Runs({ client, revision }: ViewProps) {
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
      <PageTitle
        eyebrow="EXECUTION HISTORY"
        title="运行记录"
        description=""
        action={<button onClick={data.reload}>刷新记录 ↻</button>}
      />
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

function RunTable({ runs }: { runs: readonly RunTrace[] }) {
  return runs.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>请求 / 运行</th>
            <th>状态</th>
            <th>频道</th>
            <th>当前阶段</th>
            <th>开始时间</th>
            <th aria-label="查看" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a className="run-link" href={`#/runs/${encodeURIComponent(run.id)}`}>
                  {run.summary || "无文本请求"}
                </a>
                <code className="secondary-id">{run.id.slice(0, 16)}</code>
              </td>
              <td>
                <Badge status={run.status} />
              </td>
              <td>
                <span className="channel-tag">{run.channelId}</span>
              </td>
              <td>{run.phase}</td>
              <td className="nowrap muted">{time(run.startedAt)}</td>
              <td aria-hidden="true">↗</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="暂无运行记录" text="发送消息开始运行，或调整筛选条件" />
  );
}
