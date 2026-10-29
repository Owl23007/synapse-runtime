import { type RunEvent, type RunStatus } from "@synapse/runtime-client";
import { record } from "../../../shared/lib/runtime.js";

/** 工具调用只从持久事件配对，不将运行结束推断为工具成功 */
export interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "succeeded" | "failed" | "blocked" | "uncertain" | "unrecorded";
  readonly input: unknown;
  readonly output: unknown;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
}

/** 按尝试与调用 ID 关联工具回执，保留重试、权限拒绝及未知结果的边界 */
export function toolActivities(events: readonly RunEvent[], runStatus: RunStatus): ToolActivity[] {
  const calls = new Map<string, ToolActivity>();
  for (const event of events) {
    if (!event.type.startsWith("tool_call_")) continue;
    const data = record(event.data);
    const id = `${event.attemptId ?? ""}:${typeof data.callId === "string" ? data.callId : event.id}`;
    const previous = calls.get(id);
    const status: ToolActivity["status"] =
      event.type === "tool_call_started"
        ? "running"
        : event.type === "tool_call_succeeded"
          ? "succeeded"
          : event.type === "tool_call_blocked"
            ? "blocked"
            : event.type === "tool_call_failed"
              ? record(data.error).code === "outcome_uncertain" || record(data.error).name === "ToolCallRecoveryError"
                ? "uncertain"
                : "failed"
              : event.type === "tool_call_replayed"
                ? (previous?.status ?? "unrecorded")
                : "unrecorded";
    calls.set(id, {
      id,
      name: typeof data.name === "string" ? data.name : (previous?.name ?? "工具调用"),
      status,
      input: data.input ?? previous?.input,
      output: data.output ?? data.error ?? data.reason ?? previous?.output,
      startedAt: previous?.startedAt ?? event.occurredAt,
      ...(event.type === "tool_call_started" ? {} : { finishedAt: event.occurredAt }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
    });
  }
  for (const [id, call] of calls) {
    if (call.status === "running" && !["accepted", "running"].includes(runStatus)) {
      calls.set(id, { ...call, status: runStatus === "uncertain" ? "uncertain" : "unrecorded" });
    }
  }
  return [...calls.values()];
}

/** 用本地自然日分组会话，缺失日期归入更早且不伪造时间 */
export function sessionDay(value: unknown, now = new Date()): string {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "更早";
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return date.toDateString() === yesterday.toDateString() ? "昨天" : "更早";
}

/** 列表只显示必要时间，完整时间通过元素标题提供 */
export function shortTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleString(
    "zh-CN",
    sessionDay(value) === "今天" ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" }
  );
}

/** 每条对话均显示具体时刻，历史消息同时保留日期以避免只看到月日 */
export function messageTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) return "时间未记录";
  return new Date(value).toLocaleString("zh-CN", {
    ...(sessionDay(value) === "今天" ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/** 翻译已知运行阶段，未知扩展保留原始名称供排查 */
export function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    accepted: "等待执行",
    queue: "排队中",
    context: "解析上下文",
    model: "调用模型",
    tool: "执行工具",
    artifact: "处理工件",
    response: "发送回复",
    finished: "运行结束",
    recovery: "恢复检查",
    runtime: "运行中",
    legacy: "历史记录"
  };
  return labels[phase] ?? phase;
}
