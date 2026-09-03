/** PRD 的生命周期状态 */
export type PrdStatus = "wip" | "next" | "in-progress" | "completed" | "archived";

/** 路线图展示所需的 PRD 信息 */
export interface PrdSummary {
  path: string;
  title: string;
  status: PrdStatus;
  progress: number | null;
  completedTasks: number;
  totalTasks: number;
}

const validStatuses = new Set<PrdStatus>(["wip", "next", "in-progress", "completed", "archived"]);

/**
 * 将 PRD Markdown 规范化为路线图可消费的摘要
 *
 * 显式 progress 用于没有可勾选任务的设计型 PRD，否则根据任务列表自动计算
 */
export function formatPrd(path: string, source: string): PrdSummary {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = frontmatter?.[1] ?? "";
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.split("/").pop() ?? "未命名 PRD";
  const checkedTasks = source.match(/^\s*[-*+]\s+\[[xX]\]\s+/gm)?.length ?? 0;
  const uncheckedTasks = source.match(/^\s*[-*+]\s+\[ \]\s+/gm)?.length ?? 0;
  const totalTasks = checkedTasks + uncheckedTasks;
  const progressValue = metadata.match(/^progress:\s*(\d+(?:\.\d+)?)\s*$/m)?.[1];
  const explicitProgress = progressValue === undefined ? undefined : Number(progressValue);
  const progress =
    explicitProgress === undefined
      ? totalTasks === 0
        ? null
        : Math.round((checkedTasks / totalTasks) * 100)
      : Math.min(100, Math.max(0, Math.round(explicitProgress)));
  const statusValue = metadata.match(/^status:\s*([\w-]+)\s*$/m)?.[1] as PrdStatus | undefined;
  const status = path.includes("/archive/")
    ? "archived"
    : statusValue !== undefined && validStatuses.has(statusValue)
      ? statusValue
      : progress === 100
        ? "completed"
        : "wip";

  return { path, title, status, progress, completedTasks: checkedTasks, totalTasks };
}
