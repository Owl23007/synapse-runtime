import { type RunStatus } from "@synapse/runtime-client";
import { STATUS_LABELS } from "../lib/runtime.js";

/** 状态徽章同时使用文字和颜色传达结果 */
export function Badge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
/** 无数据状态 */
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span aria-hidden="true">◇</span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
    </div>
  );
}
/** 请求等待状态 */
export function Loading() {
  return (
    <div className="loading" role="status">
      正在读取记录…
    </div>
  );
}
/** 请求失败保持在页面内并提供明确的重试入口 */
export function ErrorNotice({ error, retry }: { error?: string | undefined; retry?: () => void }) {
  return error ? (
    <div className="notice error" role="alert">
      <span>{error}</span>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  ) : null;
}
