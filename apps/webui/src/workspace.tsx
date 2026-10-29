import { useCallback, useEffect, useMemo, useRef, useState, useId, type FormEvent } from "react";
import type { WorkspaceMessage, SessionGraphView } from "@synapse/runtime-client";
import { navigateTabs, Badge, Empty, ErrorNotice, Json, Loading, message, useLoad, type ViewProps } from "./ui.js";
import { time, workspaceMessageText, record } from "./model.js";
import { DagCanvas } from "./dag-canvas.js";
import { COMMIT_LABELS, commitSummary } from "./graph-layout.js";
import { Icon, SynapseMark } from "./icons.js";
import { ScrollLoader } from "./scroll-loader.js";
import { sessionDay, shortTime, phaseLabel } from "./workspace-model.js";
import { RunTimeline, WorkspaceInspector, useRunActivity } from "./workspace-activity.js";
import { Surface } from "./surface.js";

/** 会话列表、对话与运行面板共用真实工作区，切换会话线时隔离草稿与分页响应 */
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
  const [inspectorOpen, setInspectorOpen] = useState(() => matchMedia("(min-width: 1280px)").matches);
  const [sessionsOpen, setSessionsOpen] = useState(() => matchMedia("(min-width: 761px)").matches);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const sessionLoadingRef = useRef(false);
  const sessionSearch = useRef<HTMLInputElement>(null);
  const sessionTitle = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [menuPosition, setMenuPosition] = useState({ top: 64, left: 24 });
  const scope = `${initialSession}:${initialLine}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
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
  const latestRun = activeRun ?? lineRuns[0];
  const activity = useRunActivity(
    client,
    inspectorOpen || tab === "chat" ? latestRun?.id : undefined,
    revision + nonce
  );
  const tasksLoad = useCallback(
    () => (lineId && tab === "runs" ? client.tasks(lineId) : Promise.resolve(undefined)),
    [client, lineId, tab]
  );
  const tasks = useLoad(tasksLoad, revision + nonce);
  const taskItems = Array.isArray(record(tasks.value).tasks)
    ? (record(tasks.value).tasks as unknown[])
        .map(record)
        .filter((task) => task.sessionId === initialSession && task.branchId === lineId)
    : [];
  const artifactsLoad = useCallback(
    () => (initialSession && inspectorOpen ? client.artifacts(initialSession) : Promise.resolve(undefined)),
    [client, initialSession, inspectorOpen]
  );
  const inspectorArtifacts = useLoad(artifactsLoad, revision + nonce);
  const messages = useMemo(
    () =>
      [...new Map([...older, ...(data.value?.messages ?? [])].map((item) => [item.id, item])).values()].toSorted(
        (a, b) => a.sequence - b.sequence
      ),
    [older, data.value]
  );
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const narrow = matchMedia("(max-width: 1279px)");
    const mobile = matchMedia("(max-width: 760px)");
    const collapseInspector = () => {
      if (narrow.matches) setInspectorOpen(false);
    };
    const collapseSessions = () => {
      if (mobile.matches) setSessionsOpen(false);
    };
    narrow.addEventListener("change", collapseInspector);
    mobile.addEventListener("change", collapseSessions);
    return () => {
      narrow.removeEventListener("change", collapseInspector);
      mobile.removeEventListener("change", collapseSessions);
    };
  }, []);
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setMoreHistory(undefined);
    setSelected(undefined);
    setHead("");
    setText("");
    setForkTitle("");
    setMerging(false);
    setTab("chat");
    setError("");
    setNotice("");
    requestKey.current = undefined;
  }, [initialSession, initialLine]);
  useEffect(() => {
    const searchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSessionsOpen(true);
        requestAnimationFrame(() => sessionSearch.current?.focus());
      }
      if (event.key === "Escape" && inspectorOpen) setInspectorOpen(false);
    };
    addEventListener("keydown", searchShortcut);
    return () => removeEventListener("keydown", searchShortcut);
  }, [inspectorOpen]);
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
      setTitle("");
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
      if (scopeRef.current === scope) setText("");
    });
  };
  const commit = graph.value?.nodes.find((node) => node.id === selected);
  const mainRef = graph.value?.refs.find((ref) => ref.name === `line:${session?.mainlineId}`);
  const branchRef = graph.value?.refs.find((ref) => ref.name === `line:${lineId}`);
  const branchResult = graph.value?.nodes.find((node) => node.id === branchRef?.commitId);
  const mainResult = graph.value?.nodes.find((node) => node.id === mainRef?.commitId);
  const moreSessions = useCallback(async () => {
    const cursor = sessionCursor ?? sessions.value?.nextCursor;
    if (typeof cursor !== "number" || cursor === 0 || sessionLoadingRef.current) return;
    sessionLoadingRef.current = true;
    setSessionLoading(true);
    setSessionError("");
    try {
      const page = await client.sessions(cursor);
      if (page.nextCursor === cursor) throw new Error("会话游标未推进，请重试");
      setSessionPages((current) => [...current, ...page.items]);
      setSessionCursor(typeof page.nextCursor === "number" ? page.nextCursor : 0);
    } catch (cause) {
      setSessionError(message(cause));
    } finally {
      sessionLoadingRef.current = false;
      setSessionLoading(false);
    }
  }, [client, sessionCursor, sessions.value?.nextCursor]);
  const sessionGroups = ["今天", "昨天", "更早"].map((label) => ({
    label,
    items: sessionItems.filter(
      (item) =>
        sessionDay(item.updatedAt ?? item.createdAt) === label &&
        `${item.id} ${item.title ?? ""}`.toLowerCase().includes(search.toLowerCase())
    )
  }));
  return (
    <>
      <h1 className="sr-only">会话工作台</h1>
      <ErrorNotice
        error={error || sessions.error || data.error || graph.error || runs.error}
        retry={() => setNonce((value) => value + 1)}
      />
      {notice && (
        <div role="status" className="notice success">
          {notice}
        </div>
      )}
      <div
        className={`workbench ${inspectorOpen && initialSession ? "with-inspector" : ""} ${sessionsOpen ? "" : "sessions-collapsed"}`}
      >
        <aside className="session-pane" id="workspace-sessions" aria-label="会话与上下文">
          <div className="pane-heading">
            <h2>会话</h2>
            <button
              className="primary"
              type="submit"
              form="create-session"
              disabled={busy}
              onClick={(event) => {
                if (!title.trim()) {
                  event.preventDefault();
                  sessionTitle.current?.focus();
                }
              }}
              aria-label="创建会话"
            >
              <Icon name="plus" />
              新建
            </button>
          </div>
          <label className="session-search-field">
            <Icon name="search" />
            <input
              ref={sessionSearch}
              className="session-filter"
              aria-label="搜索会话"
              placeholder="搜索会话…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>⌘ K</kbd>
          </label>
          <form className="create-session" id="create-session" onSubmit={create}>
            <input
              ref={sessionTitle}
              aria-label="新会话名称"
              placeholder="新会话名称"
              maxLength={120}
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </form>
          <div className="session-list" data-scroll-root tabIndex={0} aria-label="会话列表">
            {sessionGroups.map(
              (group) =>
                group.items.length > 0 && (
                  <section className="session-group" key={group.label}>
                    <h3>{group.label}</h3>
                    {group.items.map((item) => (
                      <button
                        aria-pressed={initialSession === item.id}
                        key={String(item.id)}
                        className={`session-row ${initialSession === item.id ? "selected" : ""}`}
                        onClick={() => navigate(String(item.id))}
                        title={`${String(item.title ?? item.id)} · ${time(item.createdAt)}`}
                      >
                        <Icon name="chat" />
                        <strong>{String(item.title ?? item.id)}</strong>
                        <time>{shortTime(item.updatedAt ?? item.createdAt)}</time>
                      </button>
                    ))}
                  </section>
                )
            )}
            {sessions.loading && !sessions.value && <Loading />}
            {!sessionItems.length && !sessions.loading && <Empty title="还没有会话" text="输入名称创建会话" />}
            {search && sessionGroups.every((group) => !group.items.length) && <Empty title="没有匹配会话" text="" />}
            <ErrorNotice error={sessionError} retry={() => void moreSessions()} />
            <ScrollLoader
              enabled={
                typeof (sessionCursor ?? sessions.value?.nextCursor) === "number" &&
                (sessionCursor ?? sessions.value?.nextCursor) !== 0 &&
                !sessionError
              }
              loading={sessionLoading}
              onLoad={() => void moreSessions()}
            />
          </div>
          {initialSession && (
            <ContextHistory
              key={initialSession}
              client={client}
              sessionId={initialSession}
              graph={graph.value}
              branchTitle={branch?.title ?? "主线"}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                setTab("graph");
                if (!graph.value?.nodes.some((node) => node.id === id)) setHead(id);
              }}
            />
          )}
        </aside>
        <section className="workspace-content">
          {!initialSession && (
            <div className="workspace-empty-toolbar">
              <button
                className="icon-button"
                aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
                aria-expanded={sessionsOpen}
                aria-controls="workspace-sessions"
                onClick={() => setSessionsOpen(!sessionsOpen)}
              >
                <Icon name="sidebar" />
              </button>
            </div>
          )}
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
                <button
                  className="icon-button"
                  aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
                  aria-expanded={sessionsOpen}
                  aria-controls="workspace-sessions"
                  onClick={() => setSessionsOpen(!sessionsOpen)}
                >
                  <Icon name="sidebar" />
                </button>
                <div>
                  <h2 title={session?.metadata?.title ?? initialSession}>
                    {session?.metadata?.title ?? initialSession}
                  </h2>
                </div>
                <label className="line-select">
                  <Icon name="branch" />
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
                <div className="workspace-header-actions">
                  <button
                    className="icon-button"
                    aria-label="更多会话操作"
                    title="更多会话操作"
                    popoverTarget={menuId}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenuPosition({ top: rect.bottom + 8, left: Math.max(8, rect.right - 196) });
                    }}
                  >
                    <Icon name="more" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={inspectorOpen ? "收起运行面板" : "展开运行面板"}
                    title="运行面板"
                    aria-expanded={inspectorOpen}
                    aria-controls="workspace-inspector"
                    onClick={() => setInspectorOpen(!inspectorOpen)}
                  >
                    <Icon name="panel" />
                  </button>
                </div>
                <div id={menuId} popover="auto" className="workspace-menu" style={{ inset: "auto", ...menuPosition }}>
                  <Surface material="frosted">
                    <button onClick={() => setNonce((value) => value + 1)}>
                      <Icon name="refresh" />
                      刷新会话
                    </button>
                    <a className="button" href={`#/runs?sessionId=${encodeURIComponent(initialSession)}`}>
                      <Icon name="run" />
                      全部运行
                    </a>
                  </Surface>
                </div>
              </div>
              <div className="workspace-tabs tabs" role="tablist" onKeyDown={navigateTabs} aria-label="会话视图">
                {[
                  ["chat", "对话"],
                  ["graph", "上下文 DAG"],
                  ["runs", "任务"],
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
                            if (scopeRef.current !== scope) return;
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
                        <div className="message-avatar">{item.type === "user_message" ? "你" : <SynapseMark />}</div>
                        <div className="message-body">
                          <div className="message-meta">
                            <strong>
                              {item.type === "user_message"
                                ? "你"
                                : item.type === "branch_result"
                                  ? "分支结果已合并"
                                  : "Synapse"}
                            </strong>
                            <time title={time(item.createdAt)}>{shortTime(item.createdAt)}</time>
                            {item.type !== "user_message" && (
                              <button
                                className="icon-button copy-message"
                                aria-label="复制消息"
                                title="复制消息"
                                onClick={() =>
                                  void navigator.clipboard
                                    .writeText(workspaceMessageText(item.payload))
                                    .then(() => setNotice("已复制消息"))
                                    .catch((cause) => setError(message(cause)))
                                }
                              >
                                <Icon name="copy" />
                              </button>
                            )}
                          </div>
                          <div className="message-text">{workspaceMessageText(item.payload)}</div>
                        </div>
                      </article>
                    ))}
                    {latestRun && activity.events.length > 0 && (
                      <RunTimeline run={latestRun} events={activity.events} />
                    )}
                    {!messages.length && !activeRun && (
                      <Empty
                        title={branch ? "在分支上继续探索" : "准备就绪"}
                        text={native ? "输入目标，交给 Agent 执行" : "此会话尚无消息"}
                      />
                    )}
                    {activeRun && !inspectorOpen && !activity.events.length && (
                      <div className="running-strip">
                        <Badge status={activeRun.status} />
                        <span>{phaseLabel(activeRun.phase)}</span>
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
                      <div className="composer-tools">
                        <button
                          type="button"
                          className="icon-button"
                          title="查看上下文"
                          aria-label="查看上下文"
                          onClick={() => setTab("graph")}
                        >
                          <Icon name="branch" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title="查看工件"
                          aria-label="查看工件"
                          onClick={() => setTab("artifacts")}
                        >
                          <Icon name="file" />
                        </button>
                      </div>
                      <span>{native ? "Ctrl / ⌘ + Enter" : "只读会话"}</span>
                      <button
                        className="primary send-button"
                        aria-label="发送消息"
                        title={busy ? "提交中" : activeRun ? "执行中" : "发送消息"}
                        disabled={busy || !!activeRun || !native || !text.trim()}
                      >
                        <Icon name="send" />
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
                  <div className="pane-heading">
                    <h3>分支任务</h3>
                    <span className="count">{taskItems.length}</span>
                  </div>
                  <ErrorNotice error={tasks.error} retry={tasks.reload} />
                  {tasks.loading && !tasks.value && <Loading />}
                  {taskItems.map((task) => (
                    <details className="workspace-task" key={String(task.id)}>
                      <summary>
                        <Icon name="task" />
                        <strong>{String(task.executor ?? task.id)}</strong>
                        <span className="task-state">
                          {(
                            {
                              pending: "等待执行",
                              running: "执行中",
                              completed: "已完成",
                              failed: "失败",
                              blocked: "受阻",
                              cancelled: "已取消"
                            } as Record<string, string>
                          )[String(task.status)] ?? String(task.status)}
                        </span>
                      </summary>
                      <Json value={task} />
                      {["pending", "running", "blocked"].includes(String(task.status)) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await client.cancelTask(String(task.id));
                              setNotice("已请求取消任务");
                            })
                          }
                        >
                          取消任务
                        </button>
                      )}
                    </details>
                  ))}
                  {!taskItems.length && !tasks.loading && <Empty title="暂无分支任务" text="" />}
                  <div className="pane-heading">
                    <h3>关联运行</h3>
                    <span className="count">{lineRuns.length}</span>
                  </div>
                  {lineRuns.map((run) => (
                    <a className="workspace-run" key={run.id} href={`#/runs/${encodeURIComponent(run.id)}`}>
                      <div>
                        <strong>{run.summary}</strong>
                        <small>
                          {time(run.startedAt)} · {phaseLabel(run.phase)}
                        </small>
                      </div>
                      <Badge status={run.status} />
                      <span>↗</span>
                    </a>
                  ))}
                  {!lineRuns.length && <Empty title="暂无运行" text="发送消息开始运行" />}
                </div>
              ) : (
                <WorkspaceArtifacts
                  key={initialSession}
                  client={client}
                  revision={revision + nonce}
                  sessionId={initialSession}
                />
              )}
            </>
          )}
        </section>
        {inspectorOpen && initialSession && (
          <WorkspaceInspector
            run={latestRun}
            events={activity.events}
            error={activity.error}
            retry={activity.reload}
            loading={activity.loading || runs.loading}
            artifacts={inspectorArtifacts.value?.items ?? []}
            artifactsLoading={inspectorArtifacts.loading}
            artifactsError={inspectorArtifacts.error}
            retryArtifacts={inspectorArtifacts.reload}
            onArtifacts={() => {
              setTab("artifacts");
              if (matchMedia("(max-width: 1279px)").matches) setInspectorOpen(false);
            }}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </div>
    </>
  );
}

function ContextHistory({
  client,
  sessionId,
  graph,
  selected,
  branchTitle,
  onSelect
}: {
  client: ViewProps["client"];
  sessionId: string;
  graph: SessionGraphView | undefined;
  selected: string | undefined;
  branchTitle: string;
  onSelect: (id: string) => void;
}) {
  const [pages, setPages] = useState<SessionGraphView[]>([]);
  const [history, setHistory] = useState<SessionGraphView>();
  const [visited, setVisited] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    if (!graph) return;
    // 节点不可变，切换 DAG 查询头时仍保留左栏已读历史，避免滚动位置与最新提交一起消失
    setHistory((current) => ({
      ...graph,
      nodes: [...new Map([...(current?.nodes ?? []), ...graph.nodes].map((node) => [node.id, node])).values()],
      boundary: [...new Set([...(current?.boundary ?? []), ...graph.boundary])]
    }));
  }, [graph]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nodes = [
    ...new Map(
      [...(history?.nodes ?? graph?.nodes ?? []), ...pages.flatMap((page) => page.nodes)].map((node) => [node.id, node])
    ).values()
  ].toSorted((a, b) => b.createdAt - a.createdAt);
  const boundary = [...(history?.boundary ?? graph?.boundary ?? []), ...pages.flatMap((page) => page.boundary)].find(
    (id) => !visited.includes(id) && !nodes.some((node) => node.id === id)
  );
  const more = async () => {
    if (!boundary || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await client.sessionGraph(sessionId, boundary);
      if (!mounted.current) return;
      setPages((current) => [...current, page]);
      setVisited((current) => [...current, boundary]);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };
  return (
    <section className="context-history" aria-label="上下文历史">
      <div className="pane-heading">
        <h2>上下文</h2>
        <span className="history-branch" title={branchTitle}>
          <Icon name="branch" />
          {branchTitle}
        </span>
      </div>
      <div className="context-history-list" data-scroll-root tabIndex={0} aria-label="提交历史">
        {nodes.map((node) => (
          <button
            className={`context-history-row ${selected === node.id ? "selected" : ""}`}
            key={node.id}
            title={commitSummary(node)}
            onClick={() => onSelect(node.id)}
          >
            <span className="history-dot" />
            <code>{node.id.slice(-6)}</code>
            <span>{commitSummary(node)}</span>
            <time>{shortTime(new Date(node.createdAt).toISOString())}</time>
          </button>
        ))}
        {!nodes.length && <p className="context-history-empty">暂无上下文提交</p>}
        <ErrorNotice error={error} retry={() => void more()} />
        <ScrollLoader enabled={!!boundary && !error} loading={loading} onLoad={() => void more()} />
      </div>
    </section>
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
