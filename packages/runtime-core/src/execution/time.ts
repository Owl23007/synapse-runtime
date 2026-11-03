import type { ScheduleRule } from "./types.js";

/** 计算严格晚于基线的下一次发生，跳过不存在的本地时间且重复时刻每天只取一次 */
export function nextScheduleTime(rule: ScheduleRule, after: number): number | undefined {
  if (!Number.isSafeInteger(after)) throw new Error("Invalid schedule time");
  if (rule.kind === "once") {
    if (!Number.isSafeInteger(rule.at)) throw new Error("Invalid once time");
    return rule.at > after ? rule.at : undefined;
  }
  if (rule.kind === "interval") {
    if (!Number.isSafeInteger(rule.startAt) || !Number.isSafeInteger(rule.everyMs) || rule.everyMs < 60_000)
      throw new Error("Invalid interval");
    return rule.startAt > after
      ? rule.startAt
      : rule.startAt + (Math.floor((after - rule.startAt) / rule.everyMs) + 1) * rule.everyMs;
  }
  if (
    !Number.isInteger(rule.hour) ||
    rule.hour < 0 ||
    rule.hour > 23 ||
    !Number.isInteger(rule.minute) ||
    rule.minute < 0 ||
    rule.minute > 59
  )
    throw new Error("Invalid daily time");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: rule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const local = (time: number) =>
    Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
  const baseline = local(after);
  // 有限扫描同时覆盖 DST 跳时和半小时偏移，不把本地时间当作固定 UTC 偏移
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= after + 3 * 86_400_000; time += 60_000) {
    const value = local(time);
    if (Number(value.hour) !== rule.hour || Number(value.minute) !== rule.minute) continue;
    const sameDay = value.year === baseline.year && value.month === baseline.month && value.day === baseline.day;
    if (
      sameDay &&
      (Number(baseline.hour) > rule.hour ||
        (Number(baseline.hour) === rule.hour && Number(baseline.minute) >= rule.minute))
    )
      continue;
    return time;
  }
  throw new Error("No valid daily occurrence within three days");
}
