import type { GraphCommit, SessionGraphView } from "@synapse/runtime-client";

/** DAG 节点的画布位置，尺寸与节点样式使用同一坐标系 */
export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

/** 按拓扑层级布置多父节点，缺失父节点保留为查询边界而不制造虚构节点 */
export function layoutGraph(graph: SessionGraphView) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const depth = new Map<string, number>();
  for (const node of graph.nodes) {
    const parents = node.parents.filter((id) => nodes.has(id));
    indegree.set(node.id, parents.length);
    for (const id of parents) children.set(id, [...(children.get(id) ?? []), node.id]);
  }
  const pending = graph.nodes.filter((node) => !indegree.get(node.id)).toSorted((a, b) => a.createdAt - b.createdAt);
  const ordered: GraphCommit[] = [];
  for (let i = 0; i < pending.length; i++) {
    const node = pending[i]!;
    ordered.push(node);
    for (const id of children.get(node.id) ?? []) {
      depth.set(id, Math.max(depth.get(id) ?? 0, (depth.get(node.id) ?? 0) + 1));
      indegree.set(id, indegree.get(id)! - 1);
      if (indegree.get(id) === 0) pending.push(nodes.get(id)!);
    }
  }
  // 损坏数据仍可检查，避免循环关系让布局或页面卡住
  for (const node of graph.nodes) if ((indegree.get(node.id) ?? 0) > 0) ordered.push(node);
  const positions = new Map<string, GraphPosition>();
  const occupied = new Set<string>();
  let maxLane = 0;
  let maxDepth = 0;
  for (const node of ordered) {
    const rank = depth.get(node.id) ?? 0;
    const parent = node.parents.map((id) => positions.get(id)).find(Boolean);
    let lane = parent ? Math.round((parent.y - 48) / 148) : 0;
    while (occupied.has(`${rank}:${lane}`)) lane++;
    occupied.add(`${rank}:${lane}`);
    positions.set(node.id, { x: 40 + rank * 260, y: 48 + lane * 148 });
    maxLane = Math.max(maxLane, lane);
    maxDepth = Math.max(maxDepth, rank);
  }
  return { positions, width: 80 + (maxDepth + 1) * 260, height: Math.max(360, 100 + (maxLane + 1) * 148) };
}

/** 以已知内容生成节点摘要，原始模型内容仅作为文本呈现 */
export function commitSummary(node: GraphCommit): string {
  const content = node.content;
  const value = content.title ?? content.input ?? content.summary ?? content.output ?? content.text ?? content.name;
  return typeof value === "string" ? value : node.type;
}

/** 上下文节点的统一中文标签 */
export const COMMIT_LABELS: Readonly<Record<string, string>> = {
  session: "会话起点",
  input: "用户输入",
  result: "执行结果",
  output: "模型输出",
  merge: "上下文合并",
  tool_result: "工具结果"
};
