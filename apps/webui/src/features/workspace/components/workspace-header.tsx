import { navigate } from "../lib/navigation.js";
import { navigateTabs } from "../../../shared/ui/tabs.js";
import { Icon } from "../../../shared/ui/icons.js";
import { Surface } from "../../../shared/ui/surface.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 会话标题与分支共享当前作用域，运行卡片的开关统一收纳到更多操作中 */
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
  if (!data.value) return null;
  return (
    <>
      <div className="workspace-header">
        <div>
          <h2 title={`${currentPresentation.title} · ${currentPresentation.subtitle}`}>{currentPresentation.title}</h2>
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
            <button
              aria-label={inspectorOpen ? "收起运行面板" : "展开运行面板"}
              aria-expanded={inspectorOpen}
              aria-controls="workspace-inspector"
              onClick={(event) => {
                event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                setInspectorOpen(!inspectorOpen);
              }}
            >
              <Icon name="activity" />
              {inspectorOpen ? "收起运行信息" : "查看运行信息"}
            </button>
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
