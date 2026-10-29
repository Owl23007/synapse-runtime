import { Icon } from "../../../shared/ui/icons.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 新建会话表单复用工作台的初始化与幂等提交动作 */
export function NewSession({ workspace }: { workspace: WorkspaceController }) {
  const { title, setTitle, initialText, setInitialText, busy, initialMessage, create } = workspace;

  return (
    <div className="workspace-welcome">
      <form id="create-session" className="new-session-form" onSubmit={create}>
        <h2>开始新会话</h2>
        <label>
          名称
          <input
            aria-label="新会话名称"
            placeholder="可选，留空使用首条消息摘要"
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          初始消息
          <textarea
            ref={initialMessage}
            aria-label="初始消息"
            placeholder="这次想完成什么？"
            rows={4}
            maxLength={32000}
            value={initialText}
            onChange={(event) => setInitialText(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || (!title.trim() && !initialText.trim())}>
          {busy ? "创建中…" : "开始会话"}
          <Icon name="send" />
        </button>
      </form>
    </div>
  );
}
