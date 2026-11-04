import { useEffect, useMemo, useSyncExternalStore } from "react";

/** 页面名称与深链接共用配置，兼容页面不必固定展示在主导航中 */
export const PAGE_ITEMS = [
  { section: "workspace", icon: "workspace", label: "工作空间", path: "/workspace" },
  { section: "runs", icon: "activity", label: "运行", path: "/runs" },
  { section: "explorer", icon: "database", label: "数据", path: "/explorer" },
  { section: "files", icon: "file", label: "文件", path: "/files" },
  { section: "capabilities", icon: "settings", label: "能力", path: "/capabilities" },
  { section: "channels", icon: "folder", label: "频道", path: "/channels" },
  { section: "tasks", icon: "task", label: "任务", path: "/tasks" }
] as const;

/** 主导航保留工作空间、运行、文件、能力与任务，数据浏览仅保留上下文深链接 */
export const NAV_ITEMS = PAGE_ITEMS.filter(
  ({ section }) =>
    section === "workspace" ||
    section === "runs" ||
    section === "tasks" ||
    section === "files" ||
    section === "capabilities"
);

/** overview 仅标记旧首页重定向，页面范围保留兼容深链接与未知路径空状态 */
export type AppSection = (typeof PAGE_ITEMS)[number]["section"] | "overview" | "system" | "not-found";

/** Hash 路由投影，查询参数保留原生 URL 语义且运行标识只解码一次 */
export interface AppRoute {
  readonly key: string;
  readonly section: AppSection;
  readonly id: string | undefined;
  readonly query: URLSearchParams;
}

/** 解析原始深链接，旧首页保留重定向标记，损坏转义与多余路径显示不存在页面 */
export function parseRoute(hash: string): AppRoute {
  const key = hash.replace(/^#/, "") || "/";
  const split = key.indexOf("?");
  const pathname = split < 0 ? key : key.slice(0, split);
  const query = new URLSearchParams(split < 0 ? "" : key.slice(split + 1));
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[0] || "overview";
  const known = section === "overview" || section === "system" || PAGE_ITEMS.some((item) => item.section === section);
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

/** 默认首页与旧总览地址统一进入工作空间，保留原始查询参数中的编码与顺序 */
export function resolveRoute(hash: string): AppRoute {
  const route = parseRoute(hash);
  if (route.section !== "overview") return route;
  const split = route.key.indexOf("?");
  return {
    ...route,
    key: `/workspace${split < 0 ? "" : route.key.slice(split)}`,
    section: "workspace"
  };
}

function subscribe(listener: () => void) {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
}

/** 订阅浏览器地址并替换旧首页，不增加历史记录或在重定向前加载运行总览 */
export function useHashRoute(): AppRoute {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash,
    () => ""
  );
  const route = useMemo(() => resolveRoute(hash), [hash]);
  useEffect(() => {
    if (route.key !== (hash.replace(/^#/, "") || "/")) history.replaceState(history.state, "", `#${route.key}`);
  }, [hash, route.key]);
  return route;
}
