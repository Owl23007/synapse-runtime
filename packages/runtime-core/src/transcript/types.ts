import type { ConversationType } from "../context/types.js";
import type { SynapseMessage } from "@synapse/runtime-protocol";

export interface TranscriptMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly lineId?: string | undefined;
  readonly normalizedEventId?: string | undefined;
  readonly lineEventId?: string | undefined;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly message?: SynapseMessage | undefined;
  readonly rawPayload?: unknown;
  readonly eventType?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly createdAt: string;
  readonly externalMessageId?: string;
  readonly deletedAt?: string;
}

export interface TranscriptAppendInput {
  readonly sessionId: string;
  readonly lineId?: string | undefined;
  readonly normalizedEventId?: string | undefined;
  readonly lineEventId?: string | undefined;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly message?: SynapseMessage | undefined;
  readonly rawPayload?: unknown;
  readonly eventType?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly createdAt?: string;
  readonly externalMessageId?: string;
}

export interface TranscriptStore {
  /** 幂等追加一条转录消息 */
  append(input: TranscriptAppendInput): Promise<TranscriptMessage>;
  /** 读取会话最近的转录消息 */
  listRecent(sessionId: string, options?: TranscriptListRecentOptions): Promise<readonly TranscriptMessage[]>;
  /** 按外部消息标识查找转录消息 */
  findByExternalMessageId?(input: TranscriptExternalMessageLookup): Promise<TranscriptMessage | undefined>;
}

export interface TranscriptListRecentOptions {
  readonly limit?: number;
  readonly lineId?: string;
}

export interface TranscriptExternalMessageLookup {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly externalMessageId: string;
}
