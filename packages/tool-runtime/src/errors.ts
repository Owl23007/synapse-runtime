import type { ToolCallRecoveryErrorCode } from "./types.js";

/**
 * 工具调用恢复无法安全继续时抛出的错误
 */
export class ToolCallRecoveryError extends Error {
  readonly code: ToolCallRecoveryErrorCode;
  readonly detail?: unknown;

  constructor(code: ToolCallRecoveryErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "ToolCallRecoveryError";
    this.code = code;
    this.detail = detail;
  }
}
