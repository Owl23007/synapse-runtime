import { type RunTrace } from "@synapse/runtime-client";

/** 缺失或非法耗时不显示为零，保留短任务的毫秒精度 */
export function durationLabel(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "未记录";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 活跃运行按当前时间计时，终态缺失结束时间时不猜测耗时 */
export function runDuration(run: RunTrace, now = Date.now()): number | undefined {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : ["accepted", "running"].includes(run.status) ? now : NaN;
  const duration = end - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

/** 列表优先显示时分，完整日期通过原生提示保留 */
export function shortTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未记录";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
