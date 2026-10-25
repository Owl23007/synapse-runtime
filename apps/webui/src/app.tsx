import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
          <p>可观测的 DAG Agent Runtime</p>
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
              { overview: "总览", runs: "运行记录", explorer: "数据浏览", system: "系统状态" } as Record<string, string>
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
          {section === "overview" ? (
            <Overview client={connection.client} revision={revision} />
          ) : section === "runs" ? (
            id ? (
              <RunDetail key={id} client={connection.client} id={id} revision={revision} />
            ) : (
              <Runs key={route} client={connection.client} revision={revision} />
            )
          ) : section === "explorer" ? (
            <Explorer
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
          <span className="eyebrow">从请求到交付，完整可见</span>
          <h1>
            让每一次执行
            <br />
            都有迹可循。
          </h1>
          <p>
            检查模型输入、追踪工具调用、回溯上下文。
            <br />
            在同一个工作空间，理解 Agent 的每一步。
          </p>
          <div className="journey">
            <span>请求</span>
            <i />
            <span>上下文</span>
            <i />
            <span>模型 · 工具</span>
            <i />
            <span>交付</span>
          </div>
        </div>
        <small>Synapse Runtime / 0.1 开发版</small>
      </div>
      <div className="connect-form">
        <form onSubmit={submit}>
          <span className="eyebrow">连接你的工作空间</span>
          <h2>连接 Runtime</h2>
          <p className="muted">使用 Runtime 的管理地址和访问令牌</p>
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
          <p className="hint">令牌仅保留在本页内存中，刷新后需要重新连接。未配置令牌的本地服务可直接连接。</p>
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
        description="从一条请求，看到完整执行路径。"
        action={
          <a className="button" href="#/runs">
            查看全部运行 ↗
          </a>
        }
      />
      <ErrorNotice error={data.error} retry={data.reload} />
      <div className="metrics">
        {[
          ["最近运行", runs.length, "最近 50 条记录"],
          ["执行中", runs.filter((r) => ["accepted", "running"].includes(r.status)).length, "等待或正在执行"],
          ["已完成", runs.filter((r) => r.status === "succeeded").length, "结果与回复已确认交付"],
          [
            "需要关注",
            runs.filter((r) => ["failed", "blocked", "uncertain", "interrupted"].includes(r.status)).length,
            "检查失败与待确认结果"
          ]
        ].map(([label, value, note]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{data.loading && !data.value ? "—" : value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>最近运行</h2>
            <p>运行状态来自持久记录，实时更新</p>
          </div>
          <span className="subtle-label">LATEST ACTIVITY</span>
        </div>
        {data.loading && !data.value ? <Loading /> : <RunTable runs={runs.slice(0, 8)} />}
      </section>
      <div className="guide-grid">
        <a href="#/explorer" className="guide-card">
          <span className="guide-icon">◇</span>
          <h3>沿着上下文，找到依据</h3>
          <p>浏览会话消息、引用与不可变提交，检查执行时使用的数据。</p>
          <span>打开数据浏览 →</span>
        </a>
        <div className="guide-card">
          <span className="guide-icon">↗</span>
          <h3>交付确认，才算完成</h3>
          <p>“结果待确认”表示外部操作缺少可靠回执。请先核实平台结果，避免重复发送。</p>
          <span className="muted">可在运行详情查看回执与处理建议</span>
        </div>
      </div>
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
        description="检查每一次执行的输入、决策与交付结果。"
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

function System({ client }: { client: RuntimeAdminClient }) {
  const load = useCallback(() => client.status(), [client]);
  const data = useLoad(load);
  const status = record(data.value);
  return (
    <>
      <PageTitle
        eyebrow="SYSTEM"
        title="系统状态"
        description="检查 Runtime 与频道连接的当前状态。"
        action={<button onClick={data.reload}>刷新 ↻</button>}
      />
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading ? (
        <Loading />
      ) : (
        <>
          <section className="panel padded">
            <h2>Runtime</h2>
            <Json value={status.runtime} />
          </section>
          <section className="panel padded">
            <h2>频道</h2>
            {Array.isArray(status.channels) && status.channels.length ? (
              status.channels.map((channel, i) => <Json key={i} value={channel} />)
            ) : (
              <Empty title="尚未配置频道" text="在 Runtime 配置中启用频道后，连接状态会显示在这里" />
            )}
          </section>
        </>
      )}
    </>
  );
}

/** 页面共享的真实服务访问上下文 */
export interface ViewProps {
  readonly client: RuntimeAdminClient;
  readonly revision: number;
}

/** 丢弃页面切换与刷新前的旧响应，保留错误前的可用数据 */
export function useLoad<T>(load: () => Promise<T>, revision = 0) {
  const [result, setResult] = useState<{ source: () => Promise<T>; value: T }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void load()
      .then((result) => {
        if (active) setResult({ source: load, value: result });
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, revision, nonce]);
  return {
    value: result?.source === load ? result.value : undefined,
    error,
    loading,
    reload: () => setNonce((v) => v + 1)
  };
}
/** 将未知错误转换为可呈现文本 */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请检查服务连接";
}
/** 状态徽章同时使用文字和颜色传达结果 */
export function Badge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
/** 页面标题与主要操作 */
export function PageTitle({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
/** 无数据状态 */
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span>◇</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
/** 请求等待状态 */
export function Loading() {
  return (
    <div className="loading" role="status">
      正在读取记录…
    </div>
  );
}
/** 请求失败保持在页面内并提供明确的重试入口 */
export function ErrorNotice({ error, retry }: { error?: string | undefined; retry?: () => void }) {
  return error ? (
    <div className="notice error" role="alert">
      <span>{error}</span>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  ) : null;
}
/** 以文本显示结构化数据，模型内容不会作为 HTML 执行 */
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{value === undefined ? "未记录" : JSON.stringify(value, null, 2)}</pre>;
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
              <td>
                <a aria-label={`查看运行 ${run.id}`} href={`#/runs/${encodeURIComponent(run.id)}`}>
                  ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="暂无运行记录" text="向已连接的频道发送消息后，可在这里查看执行过程。也可以调整筛选条件。" />
  );
}
