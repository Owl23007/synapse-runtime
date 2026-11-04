import { useEffect, useRef, useState } from "react";

/** 合并持久流通知与前台补读，隐藏页面暂停请求，恢复可见时补齐状态 */
export function useRunsRefresh(revision: number): number {
  const [refresh, setRefresh] = useState(0);
  const previous = useRef(revision);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    if (document.visibilityState === "visible" && navigator.onLine) setRefresh((value) => value + 1);
  }, [revision]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && navigator.onLine) setRefresh((value) => value + 1);
    };
    // 事件流负责及时更新，低频补读覆盖断流与休眠恢复，避免依赖手动刷新
    const timer = setInterval(update, 30000);
    addEventListener("focus", update);
    addEventListener("online", update);
    addEventListener("offline", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", update);
      removeEventListener("online", update);
      removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return refresh;
}
