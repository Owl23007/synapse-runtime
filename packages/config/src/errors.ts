/** 配置错误代码 */
export type ConfigErrorCode =
  | "CONFIG_FILE_READ_FAILED"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_ENV_MISSING"
  | "CONFIG_VALIDATION_FAILED";

/** 配置错误类 */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly cause?: unknown;

  constructor(code: ConfigErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.cause = cause;
  }
}
