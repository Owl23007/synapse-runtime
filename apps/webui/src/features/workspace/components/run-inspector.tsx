import { useEffect, useRef, useState } from "react";
import { type RunEvent, type RunTrace } from "@synapse/runtime-client";
import { eventLabel, time, record } from "../../../shared/lib/runtime.js";
import { toolActivities, phaseLabel } from "../lib/activity.js";
import { Badge, Empty, ErrorNotice } from "../../../shared/ui/feedback.js";
import { Json } from "../../../shared/ui/content.js";
import { Icon } from "../../../shared/ui/icons.js";

function RunClock({ run }: { run: RunTrace }) {
  const [now, setNow] = useState(Date.now());
  const live = ["accepted", "running"].includes(run.status);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, run.id]);
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : live ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return <span className="muted">耗时未记录</span>;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return (
    <time className="run-clock" title={`开始于 ${time(run.startedAt)}`}>
      {String(Math.floor(seconds / 3600)).padStart(2, "0")}:{String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:
      {String(seconds % 60).padStart(2, "0")}
    </time>
  );
}

/** 对话内的执行折叠区只呈现已记录阶段，可直接跳转完整审计 */
export function RunTimeline({ run, events }: { run: RunTrace; events: readonly RunEvent[] }) {
  return (
    <details className="execution-trace">
      <summary>
        <Icon name="chevron" />
        <strong>执行过程</strong>
        <span>{events.length} 条事件</span>
        <Badge status={run.status} />
      </summary>
      <ol>
        {events.slice(-12).map((event) => (
          <li key={event.id}>
            <span className="dot" />
            <span>{eventLabel(event.type)}</span>
            <time title={time(event.occurredAt)}>{shortEventTime(event.occurredAt)}</time>
            {event.durationMs !== undefined && <small>{event.durationMs} ms</small>}
          </li>
        ))}
      </ol>
      <a href={`#/runs/${encodeURIComponent(run.id)}`}>查看完整运行 ↗</a>
    </details>
  );
}

function shortEventTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 右上角浮动卡片汇总当前会话运行、工具与工件，窄屏以抽屉展示并管理焦点 */
export function WorkspaceInspector({
  run,
  events,
  error,
  retry,
  loading,
  artifacts,
  artifactsLoading,
  artifactsError,
  retryArtifacts,
  onArtifacts,
  onClose
}: {
  run: RunTrace | undefined;
  events: readonly RunEvent[];
  error: string;
  retry: () => void;
  loading: boolean;
  artifacts: readonly Record<string, unknown>[];
  artifactsLoading: boolean;
  artifactsError: string;
  retryArtifacts: () => void;
  onArtifacts: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const drawer = matchMedia("(max-width: 1279px)").matches;
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>(".inspector-toggle")?.focus();
    return () => {
      // 运行入口收纳在弹出菜单中，关闭抽屉后回到始终可见的更多按钮
      requestAnimationFrame(() => {
        const target =
          document.querySelector<HTMLButtonElement>(".workspace-more") ??
          (previous instanceof HTMLElement && previous.isConnected && previous !== document.body
            ? previous
            : undefined);
        target?.focus();
      });
    };
  }, [drawer]);
  const calls = toolActivities(events, run?.status ?? "interrupted");
  const labels = {
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    blocked: "受阻",
    uncertain: "结果待确认",
    unrecorded: "回执未记录"
  };
  return (
    <aside
      ref={panel}
      className="workspace-inspector"
      id="workspace-inspector"
      aria-label="运行面板"
      role={drawer ? "dialog" : undefined}
      aria-modal={drawer || undefined}
      onKeyDown={(event) => {
        if (!drawer || event.key !== "Tab") return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]')
        ].filter((node) => node.getClientRects().length > 0);
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="pane-heading">
        <h2>{run && ["accepted", "running"].includes(run.status) ? "当前运行" : "最近运行"}</h2>
        <button
          className="icon-button inspector-toggle"
          aria-label={drawer ? "关闭运行面板" : "收起运行面板"}
          title="收起运行面板"
          aria-expanded="true"
          aria-controls="workspace-inspector"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <ErrorNotice error={error} retry={retry} />
      {run ? (
        <>
          <div className="inspector-run-status">
            <Badge status={run.status} />
            <RunClock run={run} />
          </div>
          <details className="inspector-section" open>
            <summary>
              <Icon name="run" />
              <span title={run.summary}>{run.summary || "运行详情"}</span>
              <Icon name="chevron" />
            </summary>
            <div className="inspector-section-body">
              <p>{phaseLabel(run.phase)}</p>
              {run.error && <p className="run-error-text">{run.error.message}</p>}
              <a href={`#/runs/${encodeURIComponent(run.id)}`}>查看运行详情 ↗</a>
            </div>
          </details>
          <details className="inspector-section" open>
            <summary>
              <strong>工具调用</strong>
              <span className="count">{calls.length}</span>
              <Icon name="chevron" />
            </summary>
            <div className="inspector-section-body tool-activity-list">
              {calls.length ? (
                calls.map((call, index) => {
                  const input = record(call.input);
                  const preview = [input.path, input.pattern, input.query, input.command].find(
                    (value): value is string => typeof value === "string"
                  );
                  return (
                    <details className="tool-activity" key={call.id}>
                      <summary>
                        <span className="tool-index">{index + 1}</span>
                        <strong title={call.name}>{call.name}</strong>
                        {call.durationMs !== undefined && <small className="tool-duration">{call.durationMs} ms</small>}
                        <span className={`tool-status ${call.status}`} aria-hidden="true">
                          {call.status === "succeeded" ? (
                            <Icon name="check" />
                          ) : call.status === "running" ? (
                            <span className="activity-spinner" />
                          ) : (
                            labels[call.status]
                          )}
                        </span>
                        <span className="sr-only">{labels[call.status]}</span>
                        {preview && (
                          <code className="tool-input-preview" title={preview}>
                            {preview}
                          </code>
                        )}
                      </summary>
                      <div>
                        <h3>输入</h3>
                        <Json value={call.input} />
                        <h3>回执</h3>
                        <Json value={call.output} />
                      </div>
                    </details>
                  );
                })
              ) : (
                <p className="inspector-placeholder">{loading ? "正在读取工具调用…" : "暂无工具调用"}</p>
              )}
            </div>
          </details>
        </>
      ) : (
        <Empty title={loading ? "正在读取运行…" : "暂无运行"} text="" />
      )}
      <details className="inspector-section" open>
        <summary>
          <strong>相关工件</strong>
          <span className="count">{artifacts.length}</span>
          <Icon name="chevron" />
        </summary>
        <div className="inspector-section-body">
          <ErrorNotice error={artifactsError} retry={retryArtifacts} />
          {artifacts.slice(0, 6).map((artifact) => (
            <button className="related-artifact" key={String(artifact.id)} onClick={onArtifacts}>
              <Icon name="file" />
              <span title={String(artifact.name)}>{String(artifact.name)}</span>
            </button>
          ))}
          {!artifacts.length && (
            <p className="inspector-placeholder">{artifactsLoading ? "正在读取工件…" : "暂无工件"}</p>
          )}
          {artifacts.length > 0 && (
            <button className="text-button" onClick={onArtifacts}>
              打开工件列表 ↗
            </button>
          )}
        </div>
      </details>
    </aside>
  );
}
