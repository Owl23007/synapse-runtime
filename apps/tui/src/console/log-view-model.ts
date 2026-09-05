import type { ConsoleLogEntry } from "./types.js";
import type {
  StructuredLogEntry,
  StructuredLogField,
  StructuredLogKind,
  StructuredLogStatus
} from "./log-view-model-types.js";

export type {
  StructuredLogEntry,
  StructuredLogField,
  StructuredLogKind,
  StructuredLogStatus
} from "./log-view-model-types.js";

/**
 * 将运行日志转换为控制台结构化视图
 */
export function toStructuredLog(entry: ConsoleLogEntry): StructuredLogEntry {
  const metadata = entry.metadata ?? {};
  const message = entry.message;

  if (message === "Runtime received channel event.") {
    return createStructuredLog(entry, "routing", "received", "Message received", [
      field("event", metadata.eventId),
      field("channel", metadata.channelId),
      field("conversation", formatConversation(metadata.conversation)),
      field("sender", formatSender(metadata.sender)),
      field("message", formatMessage(metadata.message))
    ]);
  }

  if (message === "Runtime accepted channel event.") {
    return createStructuredLog(entry, "routing", "accepted", "Message accepted", [
      field("event", metadata.eventId),
      field("session", metadata.sessionId),
      field("user", metadata.userId),
      field("reason", metadata.reason),
      field("trigger", formatTrigger(metadata.trigger)),
      field("message", formatMessage(metadata.message))
    ]);
  }

  if (message === "Runtime ignored channel event.") {
    return createStructuredLog(entry, "routing", "ignored", "Message ignored", [
      field("event", metadata.eventId),
      field("reason", metadata.reason),
      field("trigger", formatTrigger(metadata.trigger)),
      field("channel", metadata.channelId),
      field("message", formatMessage(metadata.message))
    ]);
  }

  if (message === "Runtime agent run started.") {
    return createStructuredLog(entry, "agent", "started", "Agent run started", [
      field("event", metadata.eventId),
      field("agent", metadata.agentId),
      field("session", metadata.sessionId),
      field("user", metadata.userId),
      field("input", formatMessage(metadata.input))
    ]);
  }

  if (message === "Runtime agent run finished.") {
    const status = metadata.status === "failed" ? "failed" : metadata.status === "succeeded" ? "succeeded" : "info";
    return createStructuredLog(entry, "agent", status, "Agent run finished", [
      field("event", metadata.eventId),
      field("run", metadata.runId),
      field("agent", metadata.agentId),
      field("status", metadata.status),
      field("error", metadata.error),
      field("steps", formatSteps(metadata.steps)),
      field("output", formatMessage(metadata.output))
    ]);
  }

  if (message === "Runtime event completed.") {
    const status = metadata.status === "failed" ? "failed" : metadata.status === "succeeded" ? "succeeded" : "info";
    return createStructuredLog(entry, "event", status, "Event completed", [
      field("event", metadata.eventId),
      field("run", metadata.runId),
      field("status", metadata.status),
      field("error", metadata.error)
    ]);
  }

  if (
    message === "Runtime channel attached." ||
    message === "Channel connected." ||
    message === "Connecting channel."
  ) {
    return createStructuredLog(entry, "channel", "info", formatSentence(message), [
      field("channel", metadata.channelId),
      field("adapter", metadata.channelType),
      field("provider", metadata.provider),
      field("status", metadata.status)
    ]);
  }

  if (message.startsWith("Admin ")) {
    return createStructuredLog(entry, "admin", entry.level === "error" ? "failed" : "info", formatSentence(message), [
      field("channel", metadata.channelId),
      field("config", metadata.configPath),
      field("error", metadata.error)
    ]);
  }

  if (message.startsWith("Runtime console ")) {
    return createStructuredLog(entry, "console", entry.level === "error" ? "failed" : "info", formatSentence(message), [
      field("command", metadata.command),
      field("error", metadata.error)
    ]);
  }

  if (message.includes("server")) {
    return createStructuredLog(entry, "server", entry.level === "error" ? "failed" : "info", formatSentence(message), [
      field("host", metadata.host),
      field("port", metadata.port),
      field("admin", formatAdmin(metadata.admin)),
      field("error", metadata.error)
    ]);
  }

  return createStructuredLog(entry, "unknown", entry.level === "error" ? "failed" : "info", formatSentence(message), [
    field("details", compactJson(metadata))
  ]);
}

function createStructuredLog(
  entry: ConsoleLogEntry,
  kind: StructuredLogKind,
  status: StructuredLogStatus,
  title: string,
  fields: readonly (StructuredLogField | undefined)[]
): StructuredLogEntry {
  const visibleFields = fields.filter((value): value is StructuredLogField => value !== undefined);

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    level: entry.level,
    kind,
    status,
    title,
    summary: visibleFields
      .slice(0, 3)
      .map((item) => `${item.label}=${item.value}`)
      .join("  "),
    fields: visibleFields
  };
}

function field(label: string, value: unknown): StructuredLogField | undefined {
  const formatted = formatValue(value);

  if (formatted === undefined || formatted.length === 0) {
    return undefined;
  }

  return { label, value: formatted };
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return compactJson(value);
}

function formatConversation(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return formatValue(value);
  }

  return [value.kind, value.title, value.id].map(formatValue).filter(Boolean).join(" ");
}

function formatSender(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return formatValue(value);
  }

  return [value.displayName, value.id].map(formatValue).filter(Boolean).join(" ");
}

function formatMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return formatValue(value);
  }

  const preview =
    typeof value.textPreview === "string" && value.textPreview.length > 0 ? ` "${value.textPreview}"` : "";
  const segmentTypes = Array.isArray(value.segmentTypes) ? value.segmentTypes.join(",") : undefined;
  return (
    [value.type, segmentTypes, value.textLength === undefined ? undefined : `${value.textLength} chars`]
      .map(formatValue)
      .filter(Boolean)
      .join(" ") + preview
  );
}

function formatTrigger(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return formatValue(value);
  }

  return [value.kind, value.confidence, value.reason].map(formatValue).filter(Boolean).join(" ");
}

function formatSteps(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  return value
    .filter(isRecord)
    .map((step) => {
      const status = formatValue(step.status) ?? "-";
      const kind = formatValue(step.kind) ?? "step";
      const detail = formatValue(step.detail);
      return detail === undefined ? `${kind}:${status}` : `${kind}:${status}(${detail})`;
    })
    .join(", ");
}

function formatAdmin(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return formatValue(value);
  }

  const host = formatValue(value.host);
  const port = formatValue(value.port);
  return host === undefined || port === undefined ? undefined : `${host}:${port}`;
}

function formatSentence(value: string): string {
  return value.replace(/\.$/, "");
}

function compactJson(value: unknown): string | undefined {
  if (!isRecord(value) && !Array.isArray(value)) {
    return formatValue(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
