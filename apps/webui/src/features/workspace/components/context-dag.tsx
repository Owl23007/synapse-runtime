import { navigate } from "../lib/navigation.js";
import { Json } from "../../../shared/ui/content.js";
import { time } from "../../../shared/lib/runtime.js";
import { DagCanvas } from "./dag-canvas.js";
import { COMMIT_LABELS, commitSummary } from "../lib/graph-layout.js";
import { type WorkspaceController } from "../hooks/use-workspace.js";

/** 展示当前会话的提交图与节点详情，选择状态由工作台统一维护 */
export function WorkspaceGraph({ workspace }: { workspace: WorkspaceController }) {
  const {
    client,
    initialSession,
    setTab,
    busy,
    selected,
    setSelected,
    head,
    setHead,
    forkTitle,
    setForkTitle,
    actionKey,
    data,
    session,
    native,
    lineId,
    graph,
    act,
    commit
  } = workspace;

  return (
    <>
      <div className="graph-filter">
        <label>
          历史范围
          <select
            aria-label="图引用"
            value={head}
            onChange={(event) => {
              setHead(event.target.value);
              setSelected(undefined);
            }}
          >
            <option value="">所有引用</option>
            {graph.value?.refs.map((ref) => (
              <option value={ref.commitId} key={ref.name}>
                {ref.name.startsWith("line:")
                  ? ref.name.slice(5) === session?.mainlineId
                    ? "主线"
                    : (data.value!.branches.find((item) => `line:${item.id}` === ref.name)?.title ?? ref.name)
                  : ref.name}{" "}
                · v{ref.version}
              </option>
            ))}
            {head && !graph.value?.refs.some((ref) => ref.commitId === head) && (
              <option value={head}>历史 {head.slice(-8)}</option>
            )}
          </select>
        </label>
        {graph.loading && <span className="muted">更新图…</span>}
      </div>
      <div className={`graph-workspace ${commit ? "has-selection" : ""}`}>
        {graph.value && (
          <DagCanvas
            graph={graph.value}
            selected={selected}
            onSelect={setSelected}
            refLabels={Object.fromEntries([
              [`line:${session?.mainlineId}`, "主线"],
              ...(data.value?.branches ?? []).map((item) => [`line:${item.id}`, item.title])
            ])}
          />
        )}
        {commit && (
          <aside className="node-inspector">
            <div className="pane-heading">
              <h3>{COMMIT_LABELS[commit.type] ?? commit.type}</h3>
              <button aria-label="关闭节点详情" onClick={() => setSelected(undefined)}>
                ×
              </button>
            </div>
            <code className="node-id">{commit.id}</code>
            <p className="node-summary">{commitSummary(commit)}</p>
            <small>{time(new Date(commit.createdAt).toISOString())}</small>
            <div className="node-actions">
              {typeof commit.metadata.runId === "string" && (
                <a className="button" href={`#/runs/${encodeURIComponent(commit.metadata.runId)}`}>
                  查看关联运行 ↗
                </a>
              )}
              {native && typeof commit.metadata.lineId === "string" && (
                <button
                  onClick={() => {
                    if (commit.metadata.lineId !== lineId) navigate(initialSession, String(commit.metadata.lineId));
                    else setTab("chat");
                  }}
                >
                  继续此分支对话
                </button>
              )}
            </div>
            <div className="ref-tags">
              {graph.value?.refs
                .filter((ref) => ref.commitId === commit.id)
                .map((ref) => (
                  <span key={ref.name} title={ref.name}>
                    {ref.name === `line:${session?.mainlineId}`
                      ? "主线"
                      : (data.value?.branches.find((item) => `line:${item.id}` === ref.name)?.title ?? "运行头")}{" "}
                    · v{ref.version}
                  </span>
                ))}
            </div>
            {commit.parents.length ? (
              <div className="parent-links">
                <small>父提交</small>
                {commit.parents.map((id) => (
                  <button
                    key={id}
                    onClick={() => {
                      if (!graph.value?.nodes.some((node) => node.id === id)) setHead(id);
                      setSelected(id);
                    }}
                  >
                    {id.slice(-12)} ↗
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint">根提交 · 没有父节点</p>
            )}
            {native && (
              <form
                className="fork-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    const result = await client.forkSession(initialSession, {
                      commitId: commit.id,
                      title: forkTitle.trim(),
                      idempotencyKey: actionKey(`fork:${commit.id}:${forkTitle.trim()}`)
                    });
                    navigate(initialSession, result.branch.id);
                  });
                }}
              >
                <label>
                  新分支名称
                  <input
                    required
                    maxLength={120}
                    placeholder="探索另一种方案"
                    value={forkTitle}
                    onChange={(event) => setForkTitle(event.target.value)}
                  />
                </label>
                <button className="primary" disabled={busy || !forkTitle.trim()}>
                  从此节点分叉
                </button>
              </form>
            )}
            <details>
              <summary>节点数据</summary>
              <Json value={commit} />
            </details>
          </aside>
        )}
      </div>
      {graph.value?.truncated && (
        <div className="graph-boundary">
          <span>已显示查询范围内的历史</span>
          {graph.value.boundary.slice(0, 3).map((id) => (
            <button
              key={id}
              onClick={() => {
                setHead(id);
                setSelected(id);
              }}
            >
              继续回溯 {id.slice(-6)} ←
            </button>
          ))}
        </div>
      )}
    </>
  );
}
