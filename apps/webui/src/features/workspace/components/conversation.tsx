import { Badge, Empty } from "../../../shared/ui/feedback.js";
import { message, time, workspaceMessageText } from "../../../shared/lib/runtime.js";
import { Icon, SynapseMark } from "../../../shared/ui/icons.js";
import { messageTime, phaseLabel } from "../lib/activity.js";
import { RunTimeline } from "./run-inspector.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";
import { ChatFiles } from "./chat-files.js";

/** 回复操作放在正文底部，输入区共享执行状态并保持原生发送与频道只读边界 */
export function WorkspaceConversation({ workspace }: { workspace: WorkspaceController }) {
  const {
    client,
    initialSession,
    setTab,
    text,
    setText,
    busy,
    setError,
    setSelected,
    setOlder,
    olderCursor,
    setOlderCursor,
    moreHistory,
    setMoreHistory,
    setNotice,
    inspectorOpen,
    scope,
    scopeRef,
    data,
    native,
    lineId,
    branch,
    lineRuns,
    activeRun,
    latestRun,
    activity,
    messages,
    tail,
    act,
    send
  } = workspace;
  if (!data.value) return null;
  return (
    <>
      <div className="conversation" role="log" aria-label="会话消息">
        {(moreHistory ?? data.value.hasMore) && (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const page = await client.workspace(initialSession, lineId, olderCursor ?? data.value!.nextCursor);
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
          <article key={item.id} className={`chat-message ${item.type === "user_message" ? "user" : "assistant"}`}>
            <div className="message-avatar">{item.type === "user_message" ? "你" : <SynapseMark />}</div>
            <div className="message-body">
              <div className="message-meta">
                <strong>
                  {item.type === "user_message" ? "你" : item.type === "branch_result" ? "分支结果已合并" : "Synapse"}
                </strong>
                <time dateTime={item.createdAt} title={time(item.createdAt)}>
                  {messageTime(item.createdAt)}
                </time>
              </div>
              <div className="message-text">{workspaceMessageText(item.payload)}</div>
              {item.type !== "user_message" && (
                <div className="message-actions">
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
                </div>
              )}
            </div>
          </article>
        ))}
        {latestRun && activity.events.length > 0 && <RunTimeline run={latestRun} events={activity.events} />}
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
        {native && (
          <ChatFiles
            client={client}
            sessionId={initialSession}
            attachments={workspace.attachments}
            onChange={workspace.setAttachments}
            disabled={busy || !!activeRun}
          />
        )}
        <textarea
          aria-label="发送给 Agent 的消息"
          placeholder={native ? `向${branch?.title ?? "主线"}发送消息…` : "频道会话请从原频道发送消息"}
          disabled={!native}
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={32000}
          rows={3}
          onKeyDown={(event) => {
            if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
  );
}
