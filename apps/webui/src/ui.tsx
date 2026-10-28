import { useEffect, useState, type ReactNode } from "react";
import type { RuntimeAdminClient, RunStatus } from "@synapse/runtime-client";
import { STATUS_LABELS } from "./model.js";

/** 页面共享的真实服务访问上下文 */
export interface ViewProps {
  readonly client: RuntimeAdminClient;
  readonly revision: number;
}

/** 丢弃页面切换与刷新前的旧响应，保留错误前的可用数据 */
export function useLoad<T>(load: () => Promise<T>, revision = 0) {
  const [result, setResult] = useState<{ source: () => Promise<T>; value: T }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void load()
      .then((result) => {
        if (active) setResult({ source: load, value: result });
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, revision, nonce]);
  return {
    value: result?.source === load ? result.value : undefined,
    error,
    loading,
    reload: () => setNonce((v) => v + 1)
  };
}
/** 将未知错误转换为可呈现文本 */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请检查服务连接";
}
/** 状态徽章同时使用文字和颜色传达结果 */
export function Badge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
/** 页面标题与主要操作 */
export function PageTitle({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
/** 无数据状态 */
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span>◇</span>
      <h3>{title}</h3>
      <p>{text}</p>
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
/** 以文本显示结构化数据，模型内容不会作为 HTML 执行 */
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{value === undefined ? "未记录" : JSON.stringify(value, null, 2)}</pre>;
}
