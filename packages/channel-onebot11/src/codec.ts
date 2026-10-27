import type { OneBot11ResponsePayload } from "./types.js";
import { isRecord, parseJsonPayload, stringFromUnknown } from "./utils.js";

/** 编码 OneBot11 API 请求，echo 只用于需要关联回执的传输 */
export function encodeOneBot11Request(
  action: string,
  params: Readonly<Record<string, unknown>>,
  echo?: string
): string {
  return JSON.stringify({ action, params, ...(echo === undefined ? {} : { echo }) });
}

/** 解码传输帧，非对象或损坏的推送不会成为规范事件 */
export function decodeOneBot11Payload(data: unknown): Readonly<Record<string, unknown>> | undefined {
  const payload = parseJsonPayload(data);
  return isRecord(payload) && !Array.isArray(payload) ? payload : undefined;
}

/** 校验 API 回执字段，损坏的状态码不能被误认为成功 */
export function decodeOneBot11Response(payload: Readonly<Record<string, unknown>>): OneBot11ResponsePayload {
  if (
    (payload.status !== undefined && typeof payload.status !== "string") ||
    (payload.retcode !== undefined && (typeof payload.retcode !== "number" || !Number.isFinite(payload.retcode)))
  ) {
    throw new Error("Invalid OneBot 11 API response.");
  }
  return {
    ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    ...(typeof payload.retcode === "number" ? { retcode: payload.retcode } : {}),
    ...(payload.data === undefined ? {} : { data: payload.data }),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(typeof payload.wording === "string" ? { wording: payload.wording } : {}),
    ...(stringFromUnknown(payload.echo) === undefined ? {} : { echo: stringFromUnknown(payload.echo)! })
  };
}

/** 只有同步成功回执才可确认动作已完成，异步受理不属于成功 */
export function isOneBot11Success(response: OneBot11ResponsePayload): boolean {
  return response.status === "ok" && (response.retcode === undefined || response.retcode === 0);
}
