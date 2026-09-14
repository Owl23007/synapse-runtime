import type { RuntimeConfig } from "../config/index.js";

/** 标识不能通过热重载更新的宿主配置，错误只包含字段名以避免泄露凭据 */
export class ReloadRequiresRestartError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Configuration changes require a restart: ${fields.join(", ")}`);
    this.name = "ReloadRequiresRestartError";
  }
}

/** 在释放现有资源前检查宿主配置，避免配置快照与实际监听器或日志实例不一致 */
export function validateReloadConfig(current: RuntimeConfig, next: RuntimeConfig): void {
  const fields: string[] = [];
  for (const key of ["host", "port"] as const) {
    if (current.server[key] !== next.server[key]) fields.push(`server.${key}`);
  }
  for (const key of ["enabled", "host", "port", "logBufferSize"] as const) {
    if (current.admin[key] !== next.admin[key]) fields.push(`admin.${key}`);
  }
  if (current.runtime.logLevel !== next.runtime.logLevel) fields.push("runtime.logLevel");
  if (fields.length > 0) throw new ReloadRequiresRestartError(fields);
}
