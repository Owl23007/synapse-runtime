import { useEffect, useMemo, useRef, useState } from "react";
import { type SessionGraphView } from "@synapse/runtime-client";
import { COMMIT_LABELS, commitSummary, layoutGraph } from "../lib/graph-layout.js";
import { Empty } from "../../../shared/ui/feedback.js";
import { Surface } from "../../../shared/ui/surface.js";

/** 可缩放、平移与键盘选择的上下文画布，节点保持不可变历史语义 */
export function DagCanvas({
  graph,
  selected,
  onSelect,
  refLabels
}: {
  graph: SessionGraphView;
  selected: string | undefined;
  onSelect: (id: string) => void;
  refLabels: Readonly<Record<string, string>>;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const fit = () => {
    if (!viewport.current) return;
    setZoom(Math.max(0.2, Math.min(1, (viewport.current.clientWidth - 32) / layout.width)));
    viewport.current.scrollTo({ left: 0, top: 0 });
  };
  useEffect(() => {
    const node = selected ? layout.positions.get(selected) : undefined;
    if (!node || !viewport.current) return;
    viewport.current.scrollTo({
      left: Math.max(0, node.x * zoom - viewport.current.clientWidth / 2 + 110),
      top: Math.max(0, node.y * zoom - 100),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  }, [selected, layout, zoom]);
  return (
    <div className="dag-container">
      <Surface material="liquid" className="canvas-toolbar" role="toolbar" aria-label="画布操作">
        <span>
          <span className="dot live" /> {graph.nodes.length} 个节点 · {graph.edges.length} 条连接
        </span>
        <div className="toolbar-actions">
          <button aria-label="缩小画布" onClick={() => setZoom((value) => Math.max(0.2, value - 0.15))}>
            −
          </button>
          <output aria-label="画布缩放比例">{Math.round(zoom * 100)}%</output>
          <button aria-label="放大画布" onClick={() => setZoom((value) => Math.min(1.8, value + 0.15))}>
            ＋
          </button>
          <button onClick={fit}>适应画布</button>
        </div>
      </Surface>
      {graph.nodes.length ? (
        <div
          className="dag-viewport"
          ref={viewport}
          aria-label="上下文 DAG 画布"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const offsets: Record<string, [number, number]> = {
              ArrowLeft: [-80, 0],
              ArrowRight: [80, 0],
              ArrowUp: [0, -80],
              ArrowDown: [0, 80]
            };
            const offset = offsets[event.key];
            if (offset) {
              event.preventDefault();
              event.currentTarget.scrollBy({ left: offset[0], top: offset[1] });
            }
          }}
          onPointerDown={(event) => {
            if ((event.target as Element).closest("button")) return;
            const element = event.currentTarget;
            drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
            element.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            event.currentTarget.scrollLeft = drag.current.left - event.clientX + drag.current.x;
            event.currentTarget.scrollTop = drag.current.top - event.clientY + drag.current.y;
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
        >
          <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div
              className="dag-world"
              style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
            >
              <svg className="dag-edges" width={layout.width} height={layout.height} aria-hidden="true">
                <defs>
                  <marker
                    id="dag-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {graph.edges.map((edge) => {
                  const source = layout.positions.get(edge.source),
                    target = layout.positions.get(edge.target);
                  if (!source || !target) return null;
                  const x = source.x + 216,
                    y = source.y + 48,
                    end = target.y + 48;
                  return (
                    <path
                      key={`${edge.source}:${edge.target}`}
                      className={selected === edge.target || selected === edge.source ? "highlighted" : ""}
                      d={`M ${x} ${y} C ${x + 22} ${y}, ${target.x - 22} ${end}, ${target.x - 4} ${end}`}
                      markerEnd="url(#dag-arrow)"
                    />
                  );
                })}
              </svg>
              {graph.nodes.map((node) => {
                const pos = layout.positions.get(node.id)!;
                const refs = graph.refs.filter((ref) => ref.commitId === node.id);
                return (
                  <button
                    key={node.id}
                    className={`dag-node ${node.type} ${selected === node.id ? "selected" : ""}`}
                    style={{ left: pos.x, top: pos.y }}
                    aria-pressed={selected === node.id}
                    onClick={() => onSelect(node.id)}
                  >
                    <span className="node-type">
                      <span className="dot" />
                      {COMMIT_LABELS[node.type] ?? node.type}
                      <code>{node.id.slice(-6)}</code>
                    </span>
                    <strong>{commitSummary(node)}</strong>
                    <small>
                      {refs.length ? `${refs.map((ref) => refLabels[ref.name] ?? "运行").join(" · ")} · ` : ""}
                      {new Date(node.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <Empty title="尚无上下文节点" text="发起一次运行后查看执行历史" />
      )}
      <div className="canvas-footer">
        <span>拖动或方向键平移 · Tab 选择节点</span>
        <span>
          输入 <i /> 结果 <i /> 合并
        </span>
      </div>
    </div>
  );
}
