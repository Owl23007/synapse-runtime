import { navigate } from "../lib/navigation.js";
import { useId, useState, type CSSProperties } from "react";
import { Empty, ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { time } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import { ScrollLoader } from "../../../shared/ui/scroll-loader.js";
import { shortTime } from "../lib/activity.js";
import { presentSession, sessionMessageTime } from "../lib/session-presentation.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";
import { ContextHistory } from "./context-history.js";
import { useSessionSplit } from "../hooks/use-session-split.js";

/** 会话与上下文展开时允许调整分区，折叠时保留静态分隔线及原有比例 */
export function WorkspaceSessionSidebar({ workspace }: { workspace: WorkspaceController }) {
  const {
    client,
    initialSession,
    search,
    setSearch,
    setInitialText,
    sessionKind,
    setSessionKind,
    setTab,
    busy,
    selected,
    setSelected,
    setHead,
    sessionCursor,
    sessionLoading,
    sessionError,
    sessionSearch,
    initialMessage,
    sessions,
    sessionItems,
    branch,
    graph,
    moreSessions,
    sessionGroups
  } = workspace;
  const { sessionListExpanded, setSessionListExpanded } = workspace;
  const [contextExpanded, setContextExpanded] = useState(true);
  const sessionListId = useId();
  const contextListId = useId();
  const { paneRef, share, resizing, separatorProps } = useSessionSplit();

  return (
    <aside
      ref={paneRef}
      className={`session-pane ${resizing ? "is-resizing" : ""}`}
      id="workspace-sessions"
      aria-label="会话与上下文"
      style={
        {
          "--session-share": !initialSession || !contextExpanded ? 1 : share,
          "--context-share": sessionListExpanded ? 1 - share : 1
        } as CSSProperties
      }
    >
      <section className="session-section" data-collapsed={!sessionListExpanded}>
        <div className="pane-heading">
          <h2>
            <button
              className="pane-section-toggle"
              aria-label={sessionListExpanded ? "折叠会话分组" : "展开会话分组"}
              aria-expanded={sessionListExpanded}
              aria-controls={sessionListId}
              onClick={() => setSessionListExpanded(!sessionListExpanded)}
            >
              <Icon name="chevron" style={{ transform: sessionListExpanded ? "rotate(90deg)" : undefined }} />
              会话
            </button>
          </h2>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => {
              if (initialSession) {
                setInitialText("");
                navigate("");
              } else {
                initialMessage.current?.focus();
              }
            }}
            aria-label="创建会话"
          >
            <Icon name="plus" />
            新建
          </button>
        </div>
        <div className="session-section-body" id={sessionListId} hidden={!sessionListExpanded}>
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
          <div className="session-kind-filter" data-kind={sessionKind} aria-label="会话来源">
            {[
              ["all", "全部"],
              ["native", "原生"],
              ["channel", "频道"]
            ].map(([value, label]) => (
              <button key={value} aria-pressed={sessionKind === value} onClick={() => setSessionKind(value!)}>
                {label}
              </button>
            ))}
          </div>
          <div className="session-list" data-scroll-root tabIndex={0} aria-label="会话列表">
            {sessionGroups.map(
              (group) =>
                group.items.length > 0 && (
                  <section className="session-group" key={group.label}>
                    <h3>{group.label}</h3>
                    {group.items.map((item) => {
                      const presentation = presentSession(item);
                      const date = sessionMessageTime(item);
                      return (
                        <button
                          aria-pressed={initialSession === item.id}
                          key={String(item.id)}
                          className={`session-row ${initialSession === item.id ? "selected" : ""}`}
                          onClick={() => navigate(String(item.id))}
                          title={`${presentation.title} · ${presentation.subtitle} · ${time(date)}`}
                        >
                          <Icon name={presentation.native ? "chat" : "plug"} />
                          <span className="session-row-content">
                            <strong>{presentation.title}</strong>
                            <small>{presentation.subtitle}</small>
                          </span>
                          <time dateTime={date} title={time(date)}>
                            {date ? shortTime(date) : "—"}
                          </time>
                        </button>
                      );
                    })}
                  </section>
                )
            )}
            {sessions.loading && !sessions.value && <Loading />}
            {!sessionItems.length && !sessions.loading && <Empty title="还没有会话" text="点击新建开始" />}
            {search && sessionGroups.every((group) => !group.items.length) && <Empty title="没有匹配会话" text="" />}
            {!search && sessionItems.length > 0 && sessionGroups.every((group) => !group.items.length) && (
              <Empty title={sessionKind === "native" ? "暂无原生会话" : "暂无频道会话"} text="" />
            )}
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
        </div>
      </section>
      {initialSession && sessionListExpanded && contextExpanded && (
        <div
          className="session-context-resizer"
          {...separatorProps}
          aria-controls={sessionListId}
          title="拖动调整高度，双击恢复；也可使用上下方向键"
        >
          <span />
        </div>
      )}
      {initialSession && (!sessionListExpanded || !contextExpanded) && (
        <div className="session-context-divider" role="separator" aria-orientation="horizontal" />
      )}
      {initialSession && (
        <ContextHistory
          key={initialSession}
          client={client}
          sessionId={initialSession}
          graph={graph.value}
          branchTitle={branch?.title ?? "主线"}
          expanded={contextExpanded}
          onToggle={() => setContextExpanded(!contextExpanded)}
          listId={contextListId}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            setTab("graph");
            if (!graph.value?.nodes.some((node) => node.id === id)) setHead(id);
          }}
        />
      )}
    </aside>
  );
}
