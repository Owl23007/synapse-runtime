import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/navigation.js";
import { navigateTabs } from "../../../shared/ui/tabs.js";
import { Icon } from "../../../shared/ui/icons.js";
import { Surface } from "../../../shared/ui/surface.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";
import { message } from "../../../shared/lib/runtime.js";

/** 标题就地编辑，分支与运行面板入口固定排列在标题栏右侧 */
export function WorkspaceHeader({ workspace }: { workspace: WorkspaceController }) {
  const {
    initialSession,
    tab,
    setTab,
    setNonce,
    setHead,
    merging,
    setMerging,
    inspectorOpen,
    setInspectorOpen,
    menuId,
    menuPosition,
    setMenuPosition,
    data,
    session,
    currentPresentation,
    native,
    lineId,
    branch
  } = workspace;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  if (!data.value) return null;
  return (
    <>
      <div className="workspace-header">
        <div className="workspace-title">
          {editing ? (
            <form
              className="session-title-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (saving || !draft.trim()) return;
                setSaving(true);
                setError("");
                void workspace.client
                  .renameSession(initialSession, draft.trim())
                  .then(() => {
                    setNonce((value) => value + 1);
                    setEditing(false);
                    return undefined;
                  })
                  .catch((cause) => setError(message(cause)))
                  .finally(() => setSaving(false));
              }}
            >
              <input
                ref={input}
                aria-label="会话标题"
                maxLength={120}
                value={draft}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) {
                    if (event.key === "Enter") event.preventDefault();
                    return;
                  }
                  if (event.key === "Escape" && !saving) {
                    event.stopPropagation();
                    setEditing(false);
                  }
                }}
              />
              <button
                className="icon-button"
                aria-label="保存会话标题"
                title="保存标题"
                disabled={saving || !draft.trim()}
              >
                <Icon name="check" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="取消编辑标题"
                title="取消编辑"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                <Icon name="close" />
              </button>
              {error && (
                <span role="alert" className="session-title-error">
                  {error}
                </span>
              )}
            </form>
          ) : (
            <h2 title={`${currentPresentation.title} · ${currentPresentation.subtitle}`}>
              {native ? (
                <button
                  className="session-title-button"
                  title="点击编辑会话标题"
                  aria-label={`编辑会话标题：${currentPresentation.title}`}
                  onClick={() => {
                    setDraft(currentPresentation.title);
                    setError("");
                    setEditing(true);
                  }}
                >
                  <span>{currentPresentation.title}</span>
                  <Icon name="edit" />
                </button>
              ) : (
                currentPresentation.title
              )}
            </h2>
          )}
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
            className="icon-button workspace-inspector-trigger"
            aria-label={inspectorOpen ? "收起运行面板" : "展开运行面板"}
            title={inspectorOpen ? "收起运行面板" : "展开运行面板"}
            aria-pressed={inspectorOpen}
            aria-expanded={inspectorOpen}
            aria-controls="workspace-inspector"
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <Icon name="listPanel" />
          </button>
          <button
            className="icon-button workspace-more"
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
    </>
  );
}
