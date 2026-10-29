import { navigate } from "../lib/navigation.js";
import { Empty, ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { time } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import { ScrollLoader } from "../../../shared/ui/scroll-loader.js";
import { shortTime } from "../lib/activity.js";
import { presentSession, sessionMessageTime } from "../lib/session-presentation.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";
import { ContextHistory } from "./context-history.js";

/** 会话列表提供来源筛选、搜索与滚动分页，切换会话时保留列表状态 */
export function WorkspaceSessionSidebar({ workspace }: { workspace: WorkspaceController }) {
  const {
    client,
    initialSession,
    search,
    setSearch,
    title,
    setTitle,
    initialText,
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

  return (
    <aside className="session-pane" id="workspace-sessions" aria-label="会话与上下文">
      <div className="pane-heading">
        <h2>会话</h2>
        <button
          className="primary"
          type={initialSession ? "button" : "submit"}
          form={initialSession ? undefined : "create-session"}
          disabled={busy}
          onClick={(event) => {
            if (initialSession) {
              setTitle("");
              setInitialText("");
              navigate("");
            } else if (!title.trim() && !initialText.trim()) {
              event.preventDefault();
              initialMessage.current?.focus();
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
      <div className="session-kind-filter" aria-label="会话来源">
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
                      <Icon name={presentation.native ? "chat" : "folder"} />
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
  );
}
