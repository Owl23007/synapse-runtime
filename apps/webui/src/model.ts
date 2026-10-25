import type { RunEvent, RunStatus } from "@synapse/runtime-client";

/** 服务端状态的展示文案，不从事件数量推断运行结果 */
export const STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  accepted: "等待执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  blocked: "受阻",
  uncertain: "结果待确认",
  interrupted: "已中断"
};

/** 阶段名称保留未知协议扩展的可读回退 */
export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    run_accepted: "接收请求",
    run_started: "开始执行",
    run_resumed: "恢复执行",
    context_resolved: "解析上下文",
    model_call_started: "调用模型",
    model_call_succeeded: "模型返回",
    model_call_failed: "模型调用失败",
    permission_decided: "权限检查",
    tool_call_started: "执行工具",
    tool_call_succeeded: "工具完成",
    tool_call_failed: "工具失败",
    tool_call_completed: "工具返回",
    context_committed: "写入上下文",
    artifact_created: "生成工件",
    artifact_upload_started: "上传工件",
    artifact_uploaded: "工件已交付",
    artifact_upload_failed: "工件上传失败",
    artifact_upload_uncertain: "工件回执待确认",
    response_sending: "发送回复",
    response_delivered: "回复已交付",
    response_failed: "回复失败",
    response_blocked: "回复受阻",
    response_send_uncertain: "回复回执待确认",
    run_finished: "运行结束",
    run_succeeded: "运行完成",
    run_failed: "运行失败",
    run_blocked: "运行受阻",
    run_uncertain: "结果待确认",
    run_interrupted: "运行中断",
    tool_call_blocked: "工具受阻",
    tool_call_replayed: "复用工具回执",
    permission_allowed: "权限通过",
    permission_blocked: "权限拒绝",
    artifact_upload_succeeded: "工件已交付",
    response_sent: "回复已交付",
    response_send_failed: "回复发送失败"
  };
  return labels[type] ?? type;
}

/** 合并补读与实时事件，保持 Run 内顺序且拒绝混入其他运行 */
export function mergeEvents(runId: string, current: readonly RunEvent[], incoming: readonly RunEvent[]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const event of [...current, ...incoming]) if (event.runId === runId) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 校验连接地址，禁止凭据随 URL 或不受支持的协议发送 */
export function normalizeEndpoint(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("请输入不含路径、凭据和查询参数的 HTTP 或 HTTPS 服务地址");
  }
  return url.origin;
}

/** 以本地时间显示记录时间，缺失和非法值明确标记 */
export function time(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 安全读取动态检查对象，避免旧版本数据破坏整个页面 */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
