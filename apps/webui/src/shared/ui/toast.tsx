import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast, type ToastMessage } from "../lib/toast.js";
import { Icon } from "./icons.js";

const toneLabels = { success: "成功", error: "失败", warning: "注意", info: "提示" };

function ToastCard({ item }: { item: ToastMessage }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(item.duration);
  const paused = hovered || focused;
  useEffect(() => {
    if (leaving) {
      const timer = setTimeout(() => toast.dismiss(item.id), 150);
      return () => clearTimeout(timer);
    }
    if (paused || item.duration === 0) return;
    const started = Date.now();
    const timer = setTimeout(() => setLeaving(true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [item.id, item.duration, leaving, paused]);
  return (
    <div
      className={`toast toast-${item.tone}${leaving ? " toast-leaving" : ""}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="toast-symbol" aria-hidden="true">
        {item.tone === "success" ? (
          <Icon name="check" />
        ) : (
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="9" />
            {item.tone === "error" ? (
              <path d="m9 9 6 6 m-6 0 6-6" />
            ) : item.tone === "warning" ? (
              <path d="M12 7v6 M12 17h.01" />
            ) : (
              <path d="M12 11v6 M12 7h.01" />
            )}
          </svg>
        )}
      </span>
      <span className="toast-text" role={item.tone === "error" ? "alert" : "status"} aria-atomic="true">
        <span className="sr-only">{toneLabels[item.tone]}：</span>
        {item.text}
      </span>
      <button className="toast-close" type="button" aria-label="关闭提醒" onClick={() => setLeaving(true)}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** 在视口中央呈现无边框消息，空白区域允许点击穿透且不抢占输入焦点 */
export function ToastViewport() {
  const messages = useSyncExternalStore(toast.subscribe, toast.getSnapshot);
  return createPortal(
    <section className="toast-viewport" aria-label="全局消息提醒">
      {messages.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </section>,
    document.body
  );
}
