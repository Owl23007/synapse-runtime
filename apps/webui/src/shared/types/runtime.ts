import { type RuntimeAdminClient } from "@synapse/runtime-client";

/** 页面共享的真实服务访问上下文 */
export interface ViewProps {
  readonly client: RuntimeAdminClient;
  readonly revision: number;
}
