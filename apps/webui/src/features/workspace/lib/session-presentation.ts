import { type WorkspaceView } from "@synapse/runtime-client";
import { record } from "../../../shared/lib/runtime.js";

/** 原生会话的默认标题取首条消息的单行摘要，不额外发起模型调用 */
export function initialSessionTitle(text: string): string {
  const value = text.trim().replace(/\s+/g, " ");
  const points = Array.from(value);
  return points.length ? points.slice(0, 36).join("") + (points.length > 36 ? "…" : "") : "新会话";
}

/** 将频道定位序列化为可读标签，历史 ID 解析仅作为旧接口兼容回退 */
export function presentSession(item: Record<string, unknown>) {
  const id = String(item.id ?? "");
  const locator = record(item.locator);
  const metadata = record(item.metadata);
  const parts = id.split(":");
  const platform = String(
    item.platform ??
      locator.platform ??
      (item.channelId === "native" || id.startsWith("native-") ? "native" : (parts[0] ?? ""))
  );
  const provider = String(item.provider ?? locator.provider ?? parts[1] ?? "");
  const channel = String(item.channelId ?? locator.channelId ?? parts[2] ?? "");
  const kind = String(item.conversationType ?? locator.conversationType ?? parts.at(-2) ?? "");
  const conversation = String(
    item.conversationId ?? locator.conversationId ?? (parts.length >= 4 ? parts.at(-1) : "") ?? ""
  );
  const native = platform === "native";
  const names: Record<string, string> = { qq: "QQ", napcat: "NapCat", "qq-official": "QQ 官方", native: "原生" };
  const kinds: Record<string, string> = {
    group: "群聊",
    private: "私聊",
    channel: "频道",
    cli: "终端",
    system: "系统"
  };
  const conversationKind = kinds[kind] ?? "会话";
  const platformName = names[platform] ?? (platform || "频道");
  const custom = item.title ?? metadata.title;
  const channelTitle = item.conversationTitle ?? metadata.conversationTitle;
  const title = native
    ? typeof custom === "string" && custom.trim()
      ? custom
      : "新会话"
    : typeof channelTitle === "string" && channelTitle.trim()
      ? channelTitle
      : `${platformName} ${conversationKind}${conversation ? ` · ${conversation}` : channel ? ` · ${channel}` : ""}`;
  const subtitle = native ? "原生会话" : [names[provider] ?? provider, channel].filter(Boolean).join(" · ");
  return { title, subtitle, native, badge: native ? "原生" : `${platformName} ${conversationKind}` };
}

/** 选出真实消息时间，空会话才回退到创建时间 */
export function sessionMessageTime(item: Record<string, unknown>): string | undefined {
  if (!("lastMessageAt" in item)) return undefined;
  for (const value of [item.lastMessageAt, item.createdAt])
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return undefined;
}

/** 将旧工作区响应收敛为列表展示字段，不保留整页消息 */
export function workspaceSummary(view: WorkspaceView): Record<string, unknown> {
  const times = view.messages.map((message) => message.createdAt).filter((value) => Number.isFinite(Date.parse(value)));
  return { ...view.session, lastMessageAt: times.toSorted((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null };
}
