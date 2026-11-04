import { useEffect, useRef, useState } from "react";
import { Empty, ErrorNotice } from "../../../shared/ui/feedback.js";
import { message, time, workspaceMessageText } from "../../../shared/lib/runtime.js";
import { Icon, SynapseMark } from "../../../shared/ui/icons.js";
import { messageTime, phaseLabel } from "../lib/activity.js";
import { RunTimeline } from "./run-inspector.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";
import { ChatAttachments, ChatFiles } from "./chat-files.js";
import { navigate } from "../lib/navigation.js";
import { Markdown } from "../../../shared/ui/markdown.js";
import { streamedReply } from "../lib/streamed-reply.js";

/** 回复统一承载 Markdown、流式正文与运行反馈，输入目标与当前分支保持一致 */
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
    scope,
    scopeRef,
    data,
    native,
    lineId,
    branch,
    activeRun,
    latestRun,
    activity,
    messages,
    act,
    send
  } = workspace;
  const [filesBusy, setFilesBusy] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const liveText = streamedReply(activity.events);
  const latestReply = latestRun
    ? messages.findLast(
        (item) =>
          item.type === "assistant_message" &&
          (item.runId === latestRun.id ||
            (!item.runId && Date.parse(item.createdAt) >= Date.parse(latestRun.startedAt)))
      )
    : undefined;
  const showLive = native && latestRun && !latestReply && (activeRun || liveText);
  useEffect(() => setFilesBusy(false), [scope]);
  useEffect(() => {
    following.current = true;
  }, [scope]);
  useEffect(() => {
    if (following.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages.at(-1)?.id, liveText, activity.events.length]);
  if (!data.value) return null;
  const runDetails = latestRun ? (
    <div className="message-run-details">
      {activity.events.length > 0 && <RunTimeline run={latestRun} events={activity.events} />}
      <ErrorNotice error={activity.error} retry={activity.reload} />
      {!activeRun && latestRun.error && (
        <div className="message-run-error" role="status">
          <span>{latestRun.error.message}</span>
          <a href={`#/runs/${encodeURIComponent(latestRun.id)}`}>查看详情</a>
        </div>
      )}
    </div>
  ) : null;
  return (
    <>
      <div
        ref={conversation}
        className="conversation"
        role="log"
        aria-label="会话消息"
        aria-live="off"
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
        }}
      >
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
            {item.type !== "user_message" && (
              <div className="message-avatar">
                <SynapseMark />
              </div>
            )}
            <div className="message-body">
              <div className="message-meta">
                <strong>
                  {item.type === "user_message" ? "你" : item.type === "branch_result" ? "分支结果已合并" : "Synapse"}
                </strong>
                <time dateTime={item.createdAt} title={time(item.createdAt)}>
                  {messageTime(item.createdAt)}
                </time>
              </div>
              <div className="message-text">
                {item.type === "user_message" ? (
                  workspaceMessageText(item.payload)
                ) : (
                  <Markdown text={workspaceMessageText(item.payload)} />
                )}
              </div>
              {item.id === latestReply?.id && runDetails}
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
        {showLive && (
          <article className="chat-message assistant streaming-message" aria-label="正在生成的 Agent 回复">
            <div className="message-avatar">
              <SynapseMark />
            </div>
            <div className="message-body">
              <div className="message-meta">
                <strong>Synapse</strong>
                <time dateTime={latestRun.startedAt}>{messageTime(latestRun.startedAt)}</time>
                <span className="message-stream-state" role="status">
                  {activeRun ? phaseLabel(activeRun.phase) : "生成已结束"}
                </span>
              </div>
              <div className="message-text">
                {liveText ? (
                  <Markdown text={liveText} />
                ) : (
                  <span className="message-stream-placeholder">正在准备回复…</span>
                )}
              </div>
              {runDetails}
            </div>
          </article>
        )}
        {!messages.length && !activeRun && (
          <Empty
            title={branch ? "在分支上继续探索" : "准备就绪"}
            text={native ? "输入目标，交给 Agent 执行" : "此会话尚无消息"}
          />
        )}
        {!latestReply && !showLive && runDetails}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          if (busy || filesBusy || activeRun) event.preventDefault();
          else {
            following.current = true;
            send(event);
          }
        }}
      >
        {native && (
          <ChatAttachments
            attachments={workspace.attachments}
            onChange={workspace.setAttachments}
            disabled={busy || filesBusy || !!activeRun}
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
            {native && (
              <ChatFiles
                key={scope}
                client={client}
                sessionId={initialSession}
                attachments={workspace.attachments}
                onChange={(attachments) => {
                  if (scopeRef.current === scope) workspace.setAttachments(attachments);
                }}
                onBusyChange={(pending) => {
                  if (scopeRef.current === scope) setFilesBusy(pending);
                }}
                disabled={busy || !!activeRun}
              />
            )}
            <label className="composer-line-select">
              <Icon name="branch" />
              <select
                aria-label="消息目标分支"
                value={lineId}
                onChange={(event) => navigate(initialSession, event.target.value)}
              >
                <option value={data.value.session.mainlineId}>主线</option>
                {data.value.branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <Icon name="chevron" />
            </label>
          </div>
          <div className="composer-submit">
            <span className="composer-shortcut">{native ? "Ctrl / ⌘ + Enter" : "只读会话"}</span>
            <button
              className="primary send-button"
              aria-label="发送消息"
              title={busy ? "提交中" : filesBusy ? "正在附加文件…" : activeRun ? "执行中" : "发送消息"}
              disabled={busy || filesBusy || !!activeRun || !native || !text.trim()}
            >
              <Icon name="arrowUp" />
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
