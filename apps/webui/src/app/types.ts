import { type RuntimeAdminClient } from "@synapse/runtime-client";

/** 当前连接的服务与客户端，令牌仅由客户端实例在内存中持有 */
export interface RuntimeConnection {
  readonly client: RuntimeAdminClient;
  readonly endpoint: string;
}

/** 仅在当前页面内存中保留连接草稿，断开可回填，退出或刷新后清除 */
export interface ConnectionDraft {
  readonly endpoint: string;
  readonly token: string;
}
