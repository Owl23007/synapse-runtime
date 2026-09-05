import type { ConsoleLogEntry, RuntimeConsoleChannelSummary } from "./types.js";

/** 解析管理接口返回的频道摘要 */
export function parseChannelSummaries(values: readonly unknown[]): RuntimeConsoleChannelSummary[] {
  return values.filter(isRecord).map((value) => {
    const summary: {
      id: string;
      adapter: string;
      enabled: boolean;
      provider?: string;
      status?: {
        state?: string;
        detail?: string;
        checkedAt?: string;
      };
    } = {
      id: typeof value.id === "string" ? value.id : "-",
      adapter: typeof value.adapter === "string" ? value.adapter : "-",
      enabled: value.enabled === true
    };

    if (typeof value.provider === "string") {
      summary.provider = value.provider;
    }
    if (isRecord(value.status)) {
      summary.status = {};
      if (typeof value.status.state === "string") {
        summary.status.state = value.status.state;
      }
      if (typeof value.status.detail === "string") {
        summary.status.detail = value.status.detail;
      }
      if (typeof value.status.checkedAt === "string") {
        summary.status.checkedAt = value.status.checkedAt;
      }
    }
    return summary;
  });
}

/** 解析管理接口返回的日志条目 */
export function parseLogEntries(values: readonly unknown[]): ConsoleLogEntry[] {
  return values.filter(isRecord).map((value, index) => {
    const entry: {
      id: number;
      timestamp: string;
      level: ConsoleLogEntry["level"];
      message: string;
      metadata?: Readonly<Record<string, unknown>>;
    } = {
      id: typeof value.id === "number" ? value.id : index + 1,
      timestamp: typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString(),
      level: parseLogLevel(value.level),
      message: typeof value.message === "string" ? value.message : JSON.stringify(value)
    };

    if (isRecord(value.metadata)) {
      entry.metadata = value.metadata;
    }
    return entry;
  });
}

/** 将未知日志级别归一化 */
export function parseLogLevel(value: unknown): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

/** 判断未知值是否为记录对象 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
