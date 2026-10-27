import type { SynapseMessage } from "@synapse/runtime-protocol";
import { ToolCallRecoveryError } from "@synapse/runtime-tool-runtime";
import type { LineEvent } from "../context.js";

/** 持久化规范输出时兼容平台消息中的大整数 */
export function stringifyAgentOutput(message: SynapseMessage): string {
  return JSON.stringify(message, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

/** 从持久事件中读取结构化业务载荷 */
export function recordPayload(event: LineEvent): Readonly<Record<string, unknown>> | undefined {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : undefined;
}

/** 保存可恢复错误信息并保留工具恢复错误码 */
export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof ToolCallRecoveryError ? { code: error.code } : {}),
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
  }
  return error;
}

/** 控制图中工具观察大小，保留完整 JSON 而不截断业务结构 */
export function compactGraphToolResult(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const raw = payload.output;
  const output =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => !["stdout", "stderr", "logs", "script"].includes(key)))
      : raw;
  const result = { status: payload.status, reason: payload.reason, output, error: payload.error };
  const json = JSON.stringify(result);
  // 不截断 JSON，也不把未验证的工具全文当成新的系统指令
  return json.length <= 4000 ? result : { status: payload.status, truncated: true };
}
