import { useMemo, useSyncExternalStore } from "react";

/** 导航与页面名称共用配置，避免应用壳重复维护路由文案 */
export const NAV_ITEMS = [
  { section: "workspace", icon: "chat", label: "会话工作台", path: "/workspace" },
  { section: "overview", icon: "folder", label: "总览", path: "/" },
  { section: "runs", icon: "run", label: "运行记录", path: "/runs" },
  { section: "explorer", icon: "file", label: "数据浏览", path: "/explorer" },
  { section: "channels", icon: "folder", label: "频道", path: "/channels" },
  { section: "tasks", icon: "task", label: "任务", path: "/tasks" }
] as const;

/** 受支持的页面范围，未知路径保持明确的空状态 */
export type AppSection = (typeof NAV_ITEMS)[number]["section"] | "system" | "not-found";

/** Hash 路由投影，查询参数保留原生 URL 语义且运行标识只解码一次 */
export interface AppRoute {
  readonly key: string;
  readonly section: AppSection;
  readonly id: string | undefined;
  readonly query: URLSearchParams;
}

/** 解析深链接，损坏的转义和多余路径不会让页面渲染崩溃 */
export function parseRoute(hash: string): AppRoute {
  const key = hash.replace(/^#/, "") || "/";
  const split = key.indexOf("?");
  const pathname = split < 0 ? key : key.slice(0, split);
  const query = new URLSearchParams(split < 0 ? "" : key.slice(split + 1));
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[0] || "overview";
  const known = section === "system" || NAV_ITEMS.some((item) => item.section === section);
  if (!known || segments.length > (section === "runs" ? 2 : 1))
    return { key, section: "not-found", id: undefined, query };
  try {
    return {
      key,
      section: section as AppSection,
      id: segments[1] === undefined ? undefined : decodeURIComponent(segments[1]),
      query
    };
  } catch {
    return { key, section: "not-found", id: undefined, query };
  }
}

function subscribe(listener: () => void) {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
}

/** 将浏览器地址作为外部状态订阅，避免额外镜像一份路由状态 */
export function useHashRoute(): AppRoute {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash,
    () => ""
  );
  return useMemo(() => parseRoute(hash), [hash]);
}
