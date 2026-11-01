import { type RunStreamState } from "@synapse/runtime-client";
import { Icon } from "../shared/ui/icons.js";
import "./connection-card.css";

const connectionStates: Record<RunStreamState, string> = {
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  unauthorized: "认证失败",
  incompatible: "协议不兼容",
  stopped: "已断开"
};

/** 展示连接状态，断开停止订阅但保留当前页面会话供重连 */
export function ConnectionCard({
  endpoint,
  stream,
  onDisconnect
}: {
  endpoint: string;
  stream: RunStreamState;
  onDisconnect: () => void;
}) {
  const host = new URL(endpoint).host;
  const state = connectionStates[stream];
  return (
    <section className="connection-card" aria-label="当前连接" title={`${endpoint} · ${state}`}>
      <div className="connection-card-heading">
        <span className="connection-card-title">当前连接</span>
        <span className={`connection-card-state connection-state-${stream}`}>
          <span className="dot" aria-hidden="true" />
          {state}
        </span>
      </div>
      <span className="connection-card-icon" aria-hidden="true">
        <Icon name="plug" />
      </span>
      <span className="connection-card-host" title={endpoint}>
        {host}
      </span>
      <button
        type="button"
        className="connection-exit"
        onClick={onDisconnect}
        aria-label="断开连接"
        title={`断开连接 · ${host}`}
      >
        <svg
          className="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 4H4v16h5 M10 12h11 m-4-4 4 4-4 4" />
        </svg>
      </button>
    </section>
  );
}
