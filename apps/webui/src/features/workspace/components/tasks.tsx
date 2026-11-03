import { Badge, Empty, ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { Json } from "../../../shared/ui/content.js";
import { time } from "../../../shared/lib/runtime.js";
import { Icon } from "../../../shared/ui/icons.js";
import { phaseLabel } from "../lib/activity.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 工作区持久目标与当前会话线的运行分别呈现，目标控制使用 revision */
export function WorkspaceTasks({ workspace }: { workspace: WorkspaceController }) {
  const { client, busy, setNotice, lineRuns, tasks, taskItems, act } = workspace;

  return (
    <div className="workspace-runs">
      <div className="pane-heading">
        <h3>工作区目标</h3>
        <span className="count">{taskItems.length}</span>
      </div>
      <ErrorNotice error={tasks.error} retry={tasks.reload} />
      {tasks.loading && !tasks.value && <Loading />}
      {taskItems.map((task) => (
        <details className="workspace-task" key={String(task.id)}>
          <summary>
            <Icon name="task" />
            <strong>{String(task.goal ?? task.id)}</strong>
            <span className="task-state">
              {(
                {
                  open: "进行中",
                  paused: "已暂停",
                  completed: "已完成",
                  cancelled: "已取消"
                } as Record<string, string>
              )[String(task.status)] ?? String(task.status)}
            </span>
          </summary>
          <Json value={task} />
          {["open", "paused"].includes(String(task.status)) && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.cancelTask(String(task.id), Number(task.revision));
                  setNotice("已请求取消任务");
                })
              }
            >
              取消任务
            </button>
          )}
        </details>
      ))}
      {!taskItems.length && !tasks.loading && <Empty title="暂无持久目标" text="需要持续推进的工作会显示在这里" />}
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
