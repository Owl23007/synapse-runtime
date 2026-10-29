import { commitSummary } from "../lib/graph-layout.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 合并前展示两侧差异，沿用工作台的预览与确认动作 */
export function MergePreview({ workspace }: { workspace: WorkspaceController }) {
  const {
    client,
    initialSession,
    busy,
    setMerging,
    setNotice,
    actionKey,
    branch,
    activeRun,
    act,
    mainRef,
    branchRef,
    branchResult,
    mainResult
  } = workspace;
  if (!branch) return null;
  return (
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
  );
}
