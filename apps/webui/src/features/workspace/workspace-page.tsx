import { Empty, ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { Icon } from "../../shared/ui/icons.js";
import { WorkspaceInspector } from "./components/run-inspector.js";
import { useWorkspace, type WorkspaceProps } from "./hooks/use-workspace.js";
import { WorkspaceArtifacts } from "./components/artifacts.js";
import { WorkspaceSessionSidebar } from "./components/session-sidebar.js";
import { NewSession } from "./components/new-session.js";
import { MergePreview } from "./components/merge-preview.js";
import { WorkspaceHeader } from "./components/workspace-header.js";
import { WorkspaceConversation } from "./components/conversation.js";
import { WorkspaceGraph } from "./components/context-dag.js";
import { WorkspaceTasks } from "./components/tasks.js";
import "./workspace.css";

/** 会话正文与浮动运行卡片共用主区域，卡片开合不重建列表与消息状态 */
export function Workspace(props: WorkspaceProps) {
  const workspace = useWorkspace(props);
  const {
    client,
    revision,
    initialSession,
    tab,
    setTab,
    error,
    nonce,
    setNonce,
    merging,
    inspectorOpen,
    setInspectorOpen,
    sessionsOpen,
    setSessionsOpen,
    sessions,
    data,
    branch,
    graph,
    runs,
    latestRun,
    activity,
    inspectorArtifacts
  } = workspace;
  return (
    <>
      <h1 className="sr-only">会话工作台</h1>
      <ErrorNotice
        error={error || sessions.error || data.error || graph.error || runs.error}
        retry={() => setNonce((value) => value + 1)}
      />
      <div className={`workbench ${sessionsOpen ? "" : "sessions-collapsed"}`}>
        <button
          className="icon-button session-pane-toggle"
          aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
          title={sessionsOpen ? "收起会话列表" : "展开会话列表"}
          aria-expanded={sessionsOpen}
          aria-controls="workspace-sessions"
          onClick={() => setSessionsOpen(!sessionsOpen)}
        >
          <Icon name="chevron" style={{ transform: sessionsOpen ? "rotate(180deg)" : undefined }} />
        </button>
        <WorkspaceSessionSidebar workspace={workspace} />
        <section className="workspace-content">
          {!initialSession ? (
            <NewSession workspace={workspace} />
          ) : !data.value ? (
            data.loading ? (
              <Loading />
            ) : (
              <Empty title="无法打开会话" text="检查会话 ID 或重试" />
            )
          ) : (
            <>
              <WorkspaceHeader workspace={workspace} />
              {merging && branch && <MergePreview workspace={workspace} />}
              <div className={`workspace-body ${inspectorOpen ? "with-inspector" : ""}`} data-view={tab}>
                <div className="workspace-view">
                  {tab === "chat" ? (
                    <WorkspaceConversation workspace={workspace} />
                  ) : tab === "graph" ? (
                    <WorkspaceGraph workspace={workspace} />
                  ) : tab === "runs" ? (
                    <WorkspaceTasks workspace={workspace} />
                  ) : (
                    <WorkspaceArtifacts
                      key={initialSession}
                      client={client}
                      revision={revision + nonce}
                      sessionId={initialSession}
                    />
                  )}
                </div>
                {inspectorOpen && (
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
          )}
        </section>
      </div>
    </>
  );
}
