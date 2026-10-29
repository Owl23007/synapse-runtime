import { useEffect, useRef } from "react";

/** 在独立滚动区域末端读取下一页，失败后由调用方暂停观察并展示重试 */
export function ScrollLoader({ enabled, loading, onLoad }: { enabled: boolean; loading: boolean; onLoad: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    const root = node?.closest<HTMLElement>("[data-scroll-root]");
    if (!node || !root || !enabled || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoad();
      },
      { root, rootMargin: "80px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, loading, onLoad]);
  return (
    <div ref={sentinel} className="scroll-sentinel" role="status">
      {loading ? "正在加载…" : ""}
    </div>
  );
}
