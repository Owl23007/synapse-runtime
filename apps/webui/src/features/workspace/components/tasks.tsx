import { Badge, Empty, ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { Json } from "../../../shared/ui/content.js";
import { time } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import { phaseLabel } from "../lib/activity.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 当前分支的任务与运行记录支持关联跳转，状态直接使用服务端结果 */
export function WorkspaceTasks({ workspace }: { workspace: WorkspaceController }) {
  const { client, busy, setNotice, lineRuns, tasks, taskItems, act } = workspace;

  return (
    <div className="workspace-runs">
      <div className="pane-heading">
        <h3>分支任务</h3>
        <span className="count">{taskItems.length}</span>
      </div>
      <ErrorNotice error={tasks.error} retry={tasks.reload} />
      {tasks.loading && !tasks.value && <Loading />}
      {taskItems.map((task) => (
        <details className="workspace-task" key={String(task.id)}>
          <summary>
            <Icon name="task" />
            <strong>{String(task.executor ?? task.id)}</strong>
            <span className="task-state">
              {(
                {
                  pending: "等待执行",
                  running: "执行中",
                  completed: "已完成",
                  failed: "失败",
                  blocked: "受阻",
                  cancelled: "已取消"
                } as Record<string, string>
              )[String(task.status)] ?? String(task.status)}
            </span>
          </summary>
          <Json value={task} />
          {["pending", "running", "blocked"].includes(String(task.status)) && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.cancelTask(String(task.id));
                  setNotice("已请求取消任务");
                })
              }
            >
              取消任务
            </button>
          )}
        </details>
      ))}
      {!taskItems.length && !tasks.loading && <Empty title="暂无分支任务" text="" />}
      <div className="pane-heading">
        <h3>关联运行</h3>
        <span className="count">{lineRuns.length}</span>
      </div>
      {lineRuns.map((run) => (
        <a className="workspace-run" key={run.id} href={`#/runs/${encodeURIComponent(run.id)}`}>
          <div>
            <strong>{run.summary}</strong>
            <small>
              {time(run.startedAt)} · {phaseLabel(run.phase)}
            </small>
          </div>
          <Badge status={run.status} />
          <span>↗</span>
        </a>
      ))}
      {!lineRuns.length && <Empty title="暂无运行" text="发送消息开始运行" />}
    </div>
  );
}
