import { type RuntimeAdminClient } from "@synapse/runtime-client";

/** 当前连接的服务与客户端，令牌仅由客户端实例在内存中持有 */
export interface RuntimeConnection {
  readonly client: RuntimeAdminClient;
  readonly endpoint: string;
}
