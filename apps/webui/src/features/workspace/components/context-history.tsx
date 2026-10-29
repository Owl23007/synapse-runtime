import { useEffect, useRef, useState } from "react";
import { type SessionGraphView } from "@synapse/runtime-client";
import { ErrorNotice } from "../../../shared/ui/feedback.js";
import { message } from "../../../shared/lib/runtime.js";
import { type ViewProps } from "../../../shared/types/runtime.js";
import { commitSummary } from "../lib/graph-layout.js";
import { Icon } from "../../../shared/ui/icons.js";
import { ScrollLoader } from "../../../shared/ui/scroll-loader.js";
import { shortTime } from "../lib/activity.js";

/** 可折叠地回溯会话提交，隐藏列表时保留分页结果与滚动位置 */
export function ContextHistory({
  client,
  sessionId,
  graph,
  selected,
  branchTitle,
  expanded,
  onToggle,
  listId,
  onSelect
}: {
  client: ViewProps["client"];
  sessionId: string;
  graph: SessionGraphView | undefined;
  selected: string | undefined;
  branchTitle: string;
  expanded: boolean;
  onToggle: () => void;
  listId: string;
  onSelect: (id: string) => void;
}) {
  const [pages, setPages] = useState<SessionGraphView[]>([]);
  const [history, setHistory] = useState<SessionGraphView>();
  const [visited, setVisited] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    if (!graph) return;
    // 节点不可变，切换 DAG 查询头时仍保留左栏已读历史，避免滚动位置与最新提交一起消失
    setHistory((current) => ({
      ...graph,
      nodes: [...new Map([...(current?.nodes ?? []), ...graph.nodes].map((node) => [node.id, node])).values()],
      boundary: [...new Set([...(current?.boundary ?? []), ...graph.boundary])]
    }));
  }, [graph]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nodes = [
    ...new Map(
      [...(history?.nodes ?? graph?.nodes ?? []), ...pages.flatMap((page) => page.nodes)].map((node) => [node.id, node])
    ).values()
  ].toSorted((a, b) => b.createdAt - a.createdAt);
  const boundary = [...(history?.boundary ?? graph?.boundary ?? []), ...pages.flatMap((page) => page.boundary)].find(
    (id) => !visited.includes(id) && !nodes.some((node) => node.id === id)
  );
  const more = async () => {
    if (!boundary || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await client.sessionGraph(sessionId, boundary);
      if (!mounted.current) return;
      setPages((current) => [...current, page]);
      setVisited((current) => [...current, boundary]);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };
  return (
    <section className="context-history" aria-label="上下文历史" data-collapsed={!expanded}>
      <div className="pane-heading">
        <h2>
          <button
            className="pane-section-toggle"
            aria-label={expanded ? "折叠上下文" : "展开上下文"}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
          >
            <Icon name="chevron" style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
            上下文
          </button>
        </h2>
        <span className="history-branch" title={branchTitle}>
          <Icon name="branch" />
          {branchTitle}
        </span>
      </div>
      <div
        className="context-history-list"
        id={listId}
        hidden={!expanded}
        data-scroll-root
        tabIndex={0}
        aria-label="提交历史"
      >
        {nodes.map((node) => (
          <button
            className={`context-history-row ${selected === node.id ? "selected" : ""}`}
            key={node.id}
            title={commitSummary(node)}
            onClick={() => onSelect(node.id)}
          >
            <span className="history-dot" />
            <code>{node.id.slice(-6)}</code>
            <span>{commitSummary(node)}</span>
            <time>{shortTime(new Date(node.createdAt).toISOString())}</time>
          </button>
        ))}
        {!nodes.length && <p className="context-history-empty">暂无上下文提交</p>}
        <ErrorNotice error={error} retry={() => void more()} />
        <ScrollLoader enabled={!!boundary && !error} loading={loading} onLoad={() => void more()} />
      </div>
    </section>
  );
}
