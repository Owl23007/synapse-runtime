import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { WorkspaceMessage } from "@synapse/runtime-client";
import {
  navigateTabs,
  Badge,
  Empty,
  ErrorNotice,
  Json,
  Loading,
  PageTitle,
  message,
  useLoad,
  type ViewProps
} from "./ui.js";
import { time, workspaceMessageText } from "./model.js";
import { DagCanvas } from "./dag-canvas.js";
import { COMMIT_LABELS, commitSummary } from "./graph-layout.js";

/** 会话、原生执行与历史图共用一个工作区，跨页面只传持久对象标识 */
export function Workspace({
  client,
  revision,
  initialSession,
  initialLine
}: ViewProps & { initialSession: string; initialLine: string }) {
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [tab, setTab] = useState("chat");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [head, setHead] = useState("");
  const [forkTitle, setForkTitle] = useState("");
  const [merging, setMerging] = useState(false);
  const [older, setOlder] = useState<WorkspaceMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<number>();
  const [moreHistory, setMoreHistory] = useState<boolean>();
  const [sessionPages, setSessionPages] = useState<Record<string, unknown>[]>([]);
  const [sessionCursor, setSessionCursor] = useState<number>();
  const [notice, setNotice] = useState("");
  // 结果未知时保留原键；再次提交相同内容不会重复执行或创建会话
  const requestKey = useRef<{ payload: string; key: string } | undefined>(undefined);
  const actionKey = (payload: string) => {
    if (requestKey.current?.payload !== payload) requestKey.current = { payload, key: crypto.randomUUID() };
    return requestKey.current.key;
  };
  const sessionsLoad = useCallback(() => client.sessions(), [client]);
  const sessions = useLoad(sessionsLoad, revision + nonce);
  const sessionItems = [
    ...new Map([...(sessions.value?.items ?? []), ...sessionPages].map((item) => [String(item.id), item])).values()
  ];
  const load = useCallback(
    () => (initialSession ? client.workspace(initialSession, initialLine || undefined) : Promise.resolve(undefined)),
    [client, initialSession, initialLine]
  );
  const data = useLoad(load, revision + nonce);
  const session = data.value?.session;
  const native = session?.locator?.platform === "native";
  const lineId = data.value?.line.id ?? "";
  const branch = data.value?.branches.find((item) => item.id === lineId);
  const graphLoad = useCallback(
    () => (initialSession ? client.sessionGraph(initialSession, head || undefined) : Promise.resolve(undefined)),
    [client, initialSession, head]
  );
  const graph = useLoad(graphLoad, revision + nonce);
  const runsLoad = useCallback(
    () => (initialSession ? client.runs({ sessionId: initialSession, limit: 50 }) : Promise.resolve(undefined)),
    [client, initialSession]
  );
  const runs = useLoad(runsLoad, revision + nonce);
  const lineRuns = runs.value?.items.filter((run) => run.lineId === lineId) ?? [];
  const activeRun = lineRuns.find((run) => ["accepted", "running"].includes(run.status));
  const messages = useMemo(
    () =>
      [...new Map([...older, ...(data.value?.messages ?? [])].map((item) => [item.id, item])).values()].toSorted(
        (a, b) => a.sequence - b.sequence
      ),
    [older, data.value]
  );
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  }, [messages.at(-1)?.id]);
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const result = await client.createSession(title.trim(), actionKey(`create:${title.trim()}`));
      navigate(result.session.id);
    });
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !native || !lineId) return;
    void act(async () => {
      await client.submitRun({
        sessionId: initialSession,
        lineId,
        text: text.trim(),
        idempotencyKey: actionKey(`send:${initialSession}:${lineId}:${text.trim()}`)
      });
      requestKey.current = undefined;
      setText("");
    });
  };
  const commit = graph.value?.nodes.find((node) => node.id === selected);
  const mainRef = graph.value?.refs.find((ref) => ref.name === `line:${session?.mainlineId}`);
  const branchRef = graph.value?.refs.find((ref) => ref.name === `line:${lineId}`);
  const branchResult = graph.value?.nodes.find((node) => node.id === branchRef?.commitId);
  const mainResult = graph.value?.nodes.find((node) => node.id === mainRef?.commitId);
  return (
    <>
      <PageTitle
        title="会话工作台"
        description=""
        action={initialSession ? <button onClick={() => setNonce((value) => value + 1)}>刷新</button> : undefined}
      />
      <ErrorNotice
        error={error || sessions.error || data.error || graph.error || runs.error}
        retry={() => setNonce((value) => value + 1)}
      />
      {notice && (
        <div role="status" className="notice success">
          {notice}
        </div>
      )}
      <div className="workbench">
        <aside className="session-pane">
          <div className="pane-heading">
            <h2>会话</h2>
            <span className="count">{sessionItems.length}</span>
          </div>
          <form className="create-session" onSubmit={create}>
            <input
              aria-label="新会话名称"
              placeholder="新会话名称"
              maxLength={120}
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button className="primary" aria-label="创建会话" disabled={busy || !title.trim()}>
              ＋
            </button>
          </form>
          <input
            className="session-filter"
            aria-label="搜索会话"
            placeholder="搜索会话…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="session-list">
            {sessionItems
              .filter((item) => `${item.id} ${item.title ?? ""}`.toLowerCase().includes(search.toLowerCase()))
              .map((item) => (
                <button
                  aria-pressed={initialSession === item.id}
                  key={String(item.id)}
                  className={`session-row ${initialSession === item.id ? "selected" : ""}`}
                  onClick={() => navigate(String(item.id))}
                >
                  <span className="session-avatar">{item.channelId === "native" ? "↗" : "◇"}</span>
                  <span>
                    <strong>{String(item.title ?? item.id)}</strong>
                    <small>
                      {item.channelId === "native" ? "本地会话" : String(item.channelId ?? "会话")} ·{" "}
                      {time(item.createdAt)}
                    </small>
                  </span>
                </button>
              ))}
            {sessions.loading && !sessions.value && <Loading />}
            {!sessionItems.length && !sessions.loading && <Empty title="还没有会话" text="输入名称创建会话" />}
            {(sessionCursor ?? sessions.value?.nextCursor) != null && sessionCursor !== 0 && (
              <button
                className="session-more"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const page = await client.sessions(sessionCursor ?? Number(sessions.value?.nextCursor));
                    setSessionPages((current) => [...current, ...page.items]);
                    setSessionCursor(typeof page.nextCursor === "number" ? page.nextCursor : 0);
                  })
                }
              >
                加载更多会话
              </button>
            )}
          </div>
        </aside>
        <section className="workspace-content">
          {!initialSession ? (
            <div className="workspace-welcome">
              <h2>开始新的工作</h2>
              <p>创建或选择一个会话</p>
            </div>
          ) : !data.value ? (
            data.loading ? (
              <Loading />
            ) : (
              <Empty title="无法打开会话" text="检查会话 ID 或重试" />
            )
          ) : (
            <>
              <div className="workspace-header">
                <div>
                  <h2>{session?.metadata?.title ?? initialSession}</h2>
                  <small>
                    {native ? "Native" : "频道会话"} <span className="separator">/</span> {branch?.title ?? "主线"}
                  </small>
                </div>
                <label className="line-select">
                  <span className="sr-only">当前分支</span>
                  <select
                    aria-label="当前分支"
                    value={lineId}
                    onChange={(event) => navigate(initialSession, event.target.value)}
                  >
                    <option value={session?.mainlineId}>主线</option>
                    {data.value.branches.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="workspace-tabs tabs" role="tablist" onKeyDown={navigateTabs} aria-label="会话视图">
                {[
                  ["chat", "对话"],
                  ["graph", "上下文 DAG"],
                  ["runs", "运行"],
                  ["artifacts", "工件"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    role="tab"
                    tabIndex={tab === value ? 0 : -1}
                    aria-selected={tab === value}
                    onClick={() => setTab(value!)}
                  >
                    {label}
                    {value === "runs" && <span className="count">{lineRuns.length}</span>}
                  </button>
                ))}
                {native && branch && (
                  <button
                    className="merge-action"
                    onClick={() => {
                      setMerging(!merging);
                      setHead("");
                      setTab("graph");
                    }}
                  >
                    比较与合并
                  </button>
                )}
              </div>
              {merging && branch && (
                <div className="merge-panel">
                  <div className="pane-heading">
                    <h3>合并 {branch.title} → 主线</h3>
                    <button aria-label="关闭合并预览" onClick={() => setMerging(false)}>
                      ×
                    </button>
                  </div>
                  <div className="compare-grid">
                    <div>
                      <small>当前主线 · v{mainRef?.version}</small>
                      <p>{mainResult ? commitSummary(mainResult) : "暂无结果"}</p>
                    </div>
                    <div>
                      <small>
                        {branch.title} · v{branchRef?.version}
                      </small>
                      <p>{branchResult ? commitSummary(branchResult) : "暂无结果"}</p>
                    </div>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !!activeRun ||
                      !mainRef ||
                      !branchRef ||
                      branchRef.commitId === branch.contextSnapshot?.contextCommitId
                    }
                    onClick={() =>
                      void act(async () => {
                        await client.mergeSession(initialSession, {
                          branchId: branch.id,
                          expectedVersion: mainRef!.version,
                          sourceCommitId: branchRef!.commitId,
                          idempotencyKey: actionKey(`merge:${branch.id}:${mainRef!.version}:${branchRef!.commitId}`)
                        });
                        setMerging(false);
                        setNotice("分支结果已合并到主线");
                      })
                    }
                  >
                    确认合并结果
                  </button>
                </div>
              )}
              {tab === "chat" ? (
                <>
                  <div className="conversation" role="log" aria-label="会话消息">
                    {(moreHistory ?? data.value.hasMore) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const page = await client.workspace(
                              initialSession,
                              lineId,
                              olderCursor ?? data.value!.nextCursor
                            );
                            setOlder((current) => [...page.messages, ...current]);
                            setOlderCursor(page.nextCursor);
                            setMoreHistory(page.hasMore);
                          })
                        }
                      >
                        加载更早消息
                      </button>
                    )}
                    {branch?.contextSnapshot?.contextCommitId && (
                      <div className="branch-origin">
                        <span>⑂ 分叉自 {branch.contextSnapshot.contextCommitId.slice(-8)}</span>
                        <button
                          className="text-button"
                          onClick={() => {
                            setSelected(branch.contextSnapshot!.contextCommitId);
                            setTab("graph");
                          }}
                        >
                          查看来源
                        </button>
                      </div>
                    )}
                    {messages.map((item) => (
                      <article
                        key={item.id}
                        className={`chat-message ${item.type === "user_message" ? "user" : "assistant"}`}
                      >
                        <div className="message-avatar">{item.type === "user_message" ? "你" : "S"}</div>
                        <div className="message-body">
                          <div className="message-meta">
                            <strong>
                              {item.type === "user_message"
                                ? "你"
                                : item.type === "branch_result"
                                  ? "分支结果已合并"
                                  : "Synapse"}
                            </strong>
                            <time>{time(item.createdAt)}</time>
                          </div>
                          <div className="message-text">{workspaceMessageText(item.payload)}</div>
                        </div>
                      </article>
                    ))}
                    {!messages.length && !activeRun && (
                      <Empty
                        title={branch ? "在分支上继续探索" : "准备就绪"}
                        text={native ? "输入目标，交给 Agent 执行" : "此会话尚无消息"}
                      />
                    )}
                    {activeRun && (
                      <div className="running-strip">
                        <Badge status={activeRun.status} />
                        <span>{activeRun.phase}</span>
                        <a href={`#/runs/${encodeURIComponent(activeRun.id)}`}>检查运行 ↗</a>
                      </div>
                    )}
                    {!activeRun && lineRuns[0]?.error && (
                      <div className="notice error">
                        {lineRuns[0].error.message}
                        <a href={`#/runs/${encodeURIComponent(lineRuns[0].id)}`}>查看详情</a>
                      </div>
                    )}
                    <div ref={tail} />
                  </div>
                  <form className="composer" onSubmit={send}>
                    <textarea
                      aria-label="发送给 Agent 的消息"
                      placeholder={native ? `向${branch?.title ?? "主线"}发送消息…` : "频道会话请从原频道发送消息"}
                      disabled={!native}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      maxLength={32000}
                      rows={3}
                      onKeyDown={(event) => {
                        if (
                          !event.nativeEvent.isComposing &&
                          event.key === "Enter" &&
                          (event.ctrlKey || event.metaKey)
                        ) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <div className="composer-footer">
                      <span>{native ? "Ctrl / ⌘ + Enter 发送" : "只读会话"}</span>
                      <button className="primary" disabled={busy || !!activeRun || !native || !text.trim()}>
                        {busy ? "提交中…" : activeRun ? "执行中…" : "发送消息 ↑"}
                      </button>
                    </div>
                  </form>
                </>
              ) : tab === "graph" ? (
                <>
                  <div className="graph-filter">
                    <label>
                      历史范围
                      <select
                        aria-label="图引用"
                        value={head}
                        onChange={(event) => {
                          setHead(event.target.value);
                          setSelected(undefined);
                        }}
                      >
                        <option value="">所有引用</option>
                        {graph.value?.refs.map((ref) => (
                          <option value={ref.commitId} key={ref.name}>
                            {ref.name.startsWith("line:")
                              ? ref.name.slice(5) === session?.mainlineId
                                ? "主线"
                                : (data.value!.branches.find((item) => `line:${item.id}` === ref.name)?.title ??
                                  ref.name)
                              : ref.name}{" "}
                            · v{ref.version}
                          </option>
                        ))}
                        {head && !graph.value?.refs.some((ref) => ref.commitId === head) && (
                          <option value={head}>历史 {head.slice(-8)}</option>
                        )}
                      </select>
                    </label>
                    {graph.loading && <span className="muted">更新图…</span>}
                  </div>
                  <div className={`graph-workspace ${commit ? "has-selection" : ""}`}>
                    {graph.value && (
                      <DagCanvas
                        graph={graph.value}
                        selected={selected}
                        onSelect={setSelected}
                        refLabels={Object.fromEntries([
                          [`line:${session?.mainlineId}`, "主线"],
                          ...(data.value?.branches ?? []).map((item) => [`line:${item.id}`, item.title])
                        ])}
                      />
                    )}
                    {commit && (
                      <aside className="node-inspector">
                        <div className="pane-heading">
                          <h3>{COMMIT_LABELS[commit.type] ?? commit.type}</h3>
                          <button aria-label="关闭节点详情" onClick={() => setSelected(undefined)}>
                            ×
                          </button>
                        </div>
                        <code className="node-id">{commit.id}</code>
                        <p className="node-summary">{commitSummary(commit)}</p>
                        <small>{time(new Date(commit.createdAt).toISOString())}</small>
                        <div className="node-actions">
                          {typeof commit.metadata.runId === "string" && (
                            <a className="button" href={`#/runs/${encodeURIComponent(commit.metadata.runId)}`}>
                              查看关联运行 ↗
                            </a>
                          )}
                          {native && typeof commit.metadata.lineId === "string" && (
                            <button
                              onClick={() => {
                                if (commit.metadata.lineId !== lineId)
                                  navigate(initialSession, String(commit.metadata.lineId));
                                else setTab("chat");
                              }}
                            >
                              继续此分支对话
                            </button>
                          )}
                        </div>
                        <div className="ref-tags">
                          {graph.value?.refs
                            .filter((ref) => ref.commitId === commit.id)
                            .map((ref) => (
                              <span key={ref.name} title={ref.name}>
                                {ref.name === `line:${session?.mainlineId}`
                                  ? "主线"
                                  : (data.value?.branches.find((item) => `line:${item.id}` === ref.name)?.title ??
                                    "运行头")}{" "}
                                · v{ref.version}
                              </span>
                            ))}
                        </div>
                        {commit.parents.length ? (
                          <div className="parent-links">
                            <small>父提交</small>
                            {commit.parents.map((id) => (
                              <button
                                key={id}
                                onClick={() => {
                                  if (!graph.value?.nodes.some((node) => node.id === id)) setHead(id);
                                  setSelected(id);
                                }}
                              >
                                {id.slice(-12)} ↗
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="hint">根提交 · 没有父节点</p>
                        )}
                        {native && (
                          <form
                            className="fork-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void act(async () => {
                                const result = await client.forkSession(initialSession, {
                                  commitId: commit.id,
                                  title: forkTitle.trim(),
                                  idempotencyKey: actionKey(`fork:${commit.id}:${forkTitle.trim()}`)
                                });
                                navigate(initialSession, result.branch.id);
                              });
                            }}
                          >
                            <label>
                              新分支名称
                              <input
                                required
                                maxLength={120}
                                placeholder="探索另一种方案"
                                value={forkTitle}
                                onChange={(event) => setForkTitle(event.target.value)}
                              />
                            </label>
                            <button className="primary" disabled={busy || !forkTitle.trim()}>
                              从此节点分叉
                            </button>
                          </form>
                        )}
                        <details>
                          <summary>节点数据</summary>
                          <Json value={commit} />
                        </details>
                      </aside>
                    )}
                  </div>
                  {graph.value?.truncated && (
                    <div className="graph-boundary">
                      <span>已显示查询范围内的历史</span>
                      {graph.value.boundary.slice(0, 3).map((id) => (
                        <button
                          key={id}
                          onClick={() => {
                            setHead(id);
                            setSelected(id);
                          }}
                        >
                          继续回溯 {id.slice(-6)} ←
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : tab === "runs" ? (
                <div className="workspace-runs">
                  {lineRuns.map((run) => (
                    <a className="workspace-run" key={run.id} href={`#/runs/${encodeURIComponent(run.id)}`}>
                      <div>
                        <strong>{run.summary}</strong>
                        <small>
                          {time(run.startedAt)} · {run.phase}
                        </small>
                      </div>
                      <Badge status={run.status} />
                      <span>↗</span>
                    </a>
                  ))}
                  {!lineRuns.length && <Empty title="暂无运行" text="发送消息开始运行" />}
                </div>
              ) : (
                <WorkspaceArtifacts client={client} revision={revision + nonce} sessionId={initialSession} />
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function WorkspaceArtifacts({ client, revision, sessionId }: ViewProps & { sessionId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [older, setOlder] = useState<Record<string, unknown>[]>([]);
  const load = useCallback(() => client.artifacts(sessionId, cursor), [client, sessionId, cursor]);
  const data = useLoad(load, revision);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const artifacts = [
    ...new Map([...older, ...(data.value?.items ?? [])].map((item) => [String(item.id), item])).values()
  ];
  return (
    <div className="artifact-list">
      <ErrorNotice error={error || data.error} retry={data.reload} />
      {artifacts.map((item) => (
        <div className="artifact-row" key={String(item.id)}>
          <span className="file-icon">▤</span>
          <div>
            <strong>{String(item.name)}</strong>
            <small>
              {String(item.mimeType ?? "文件")} · {Math.ceil(Number(item.size ?? 0) / 1024)} KB
            </small>
          </div>
          {typeof item.runId === "string" && (
            <a className="button" href={`#/runs/${encodeURIComponent(item.runId)}`}>
              关联运行 ↗
            </a>
          )}
          <button
            disabled={!!busy}
            onClick={() => {
              setBusy(String(item.id));
              setError("");
              void client
                .downloadArtifact(sessionId, String(item.id))
                .then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = String(item.name);
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                  return undefined;
                })
                .catch((cause) => setError(message(cause)))
                .finally(() => setBusy(""));
            }}
          >
            {busy === item.id ? "下载中…" : "下载 ↓"}
          </button>
        </div>
      ))}
      {!artifacts.length && (data.loading ? <Loading /> : <Empty title="暂无工件" text="运行生成的文件将显示在这里" />)}
      {data.value?.nextCursor && (
        <button
          onClick={() => {
            setOlder(artifacts);
            setCursor(String(data.value!.nextCursor));
          }}
        >
          加载更多工件
        </button>
      )}
    </div>
  );
}

function navigate(id: string, line = "") {
  location.hash = `/workspace?session=${encodeURIComponent(id)}${line ? `&line=${encodeURIComponent(line)}` : ""}`;
}
