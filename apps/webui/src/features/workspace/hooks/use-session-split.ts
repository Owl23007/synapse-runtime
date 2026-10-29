import { useRef, useState, type HTMLAttributes } from "react";

function clampShare(value: number): number {
  return Math.min(0.8, Math.max(0.3, value));
}

/** 使用指针捕获调整左栏分区，指针离开分隔条后仍可拖动，并提供等价的键盘操作 */
export function useSessionSplit() {
  const paneRef = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; share: number; height: number } | undefined>(undefined);
  const [share, setShare] = useState(0.7);
  const [resizing, setResizing] = useState(false);
  const stop = () => {
    drag.current = undefined;
    setResizing(false);
  };
  const separatorProps: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-label": "调整会话与上下文高度",
    "aria-orientation": "horizontal",
    "aria-valuemin": 30,
    "aria-valuemax": 80,
    "aria-valuenow": Math.round(share * 100),
    "aria-valuetext": `会话 ${Math.round(share * 100)}%，上下文 ${Math.round((1 - share) * 100)}%`,
    onPointerDown(event) {
      if (event.button !== 0 || !paneRef.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { y: event.clientY, share, height: paneRef.current.clientHeight - 8 };
      setResizing(true);
    },
    onPointerMove(event) {
      const start = drag.current;
      if (start && start.height > 0) setShare(clampShare(start.share + (event.clientY - start.y) / start.height));
    },
    onPointerUp(event) {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      stop();
    },
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onDoubleClick: () => setShare(0.7),
    onKeyDown(event) {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setShare((current) =>
        clampShare(
          event.key === "Home" ? 0.3 : event.key === "End" ? 0.8 : current + (event.key === "ArrowUp" ? -0.05 : 0.05)
        )
      );
    }
  };
  return { paneRef, share, resizing, separatorProps };
}
