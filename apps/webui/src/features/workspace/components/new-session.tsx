import { useEffect } from "react";
import { Icon, SynapseMark } from "../../../shared/ui/icons.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 新对话复用自动命名与幂等创建动作，加号仅预留后续扩展入口 */
export function NewSession({ workspace }: { workspace: WorkspaceController }) {
  const { initialText, setInitialText, busy, initialMessage, create } = workspace;
  useEffect(() => {
    initialMessage.current?.focus();
  }, [initialMessage]);

  return (
    <div className="workspace-new-session">
      <header className="new-session-breadcrumb">
        工作空间 <span>/</span> 新会话
      </header>
      <div className="workspace-welcome">
        <div className="new-session-intro">
          <div className="new-session-mark">
            <SynapseMark />
          </div>
          <h2>开始新的会话</h2>
        </div>
        <form
          id="create-session"
          className="composer new-session-composer"
          onSubmit={create}
          aria-label="开始新会话"
          aria-busy={busy}
        >
          <textarea
            ref={initialMessage}
            aria-label="发送给 Agent 的消息"
            placeholder="向 Synapse 发送消息…"
            rows={3}
            maxLength={32000}
            value={initialText}
            disabled={busy}
            onChange={(event) => setInitialText(event.target.value)}
            onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <button
              type="button"
              className="icon-button composer-add"
              aria-label="添加内容（即将支持）"
              title="添加内容（即将支持）"
              disabled
            >
              <Icon name="plus" />
            </button>
            <span className="new-session-shortcut">Enter 发送 · Shift + Enter 换行</span>
            <button
              className="primary send-button"
              aria-label="发送消息"
              title={busy ? "正在开始会话…" : "发送消息"}
              disabled={busy || !initialText.trim()}
            >
              <Icon name="send" />
            </button>
          </div>
        </form>
        <span className="sr-only" role="status">
          {busy ? "正在开始会话…" : ""}
        </span>
      </div>
    </div>
  );
}
