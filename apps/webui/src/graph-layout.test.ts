import { describe, expect, it } from "vitest";
import type { GraphCommit, SessionGraphView } from "@synapse/runtime-client";
import { layoutGraph } from "./graph-layout.js";

function commit(id: string, parents: string[] = []): GraphCommit {
  return { id, parents, type: "input", content: {}, metadata: {}, createdAt: 1 };
}
function graph(nodes: GraphCommit[]): SessionGraphView {
  return {
    nodes,
    edges: nodes.flatMap((node) => node.parents.map((parent) => ({ source: parent, target: node.id }))),
    refs: [],
    truncated: false,
    boundary: []
  };
}
describe("上下文 DAG 布局", () => {
  it("乱序输入、多父合并和分叉都按拓扑层级布局，节点不重叠", () => {
    const layout = layoutGraph(
      graph([commit("merge", ["a", "b"]), commit("a", ["root"]), commit("b", ["root"]), commit("root")])
    );
    const pos = (id: string) => layout.positions.get(id)!;
    expect(pos("a").x).toBeGreaterThan(pos("root").x);
    expect(pos("merge").x).toBeGreaterThan(pos("a").x);
    expect(pos("merge").x).toBeGreaterThan(pos("b").x);
    expect(pos("a").y).not.toBe(pos("b").y);
    expect(new Set([...layout.positions.values()].map((point) => `${point.x},${point.y}`)).size).toBe(4);
  });
  it("空图、历史边界与异常环均返回有限画布，不生成缺失父节点", () => {
    expect(layoutGraph(graph([])).positions.size).toBe(0);
    expect(layoutGraph(graph([commit("head", ["outside"])])).positions.size).toBe(1);
    const cyclic = layoutGraph(graph([commit("a", ["b"]), commit("b", ["a"])]));
    expect(cyclic.positions.size).toBe(2);
    expect(Number.isFinite(cyclic.width)).toBe(true);
  });
});
