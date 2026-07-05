import type { ConversationType } from "../context/types.js";

export interface TranscriptMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly createdAt: string;
  readonly externalMessageId?: string;
  readonly deletedAt?: string;
}

export interface TranscriptAppendInput {
  readonly sessionId: string;
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly actorId?: string;
  readonly text: string;
  readonly createdAt?: string;
  readonly externalMessageId?: string;
}

export interface TranscriptStore {
  append(input: TranscriptAppendInput): Promise<TranscriptMessage>;
  listRecent(sessionId: string, options?: { readonly limit?: number }): Promise<readonly TranscriptMessage[]>;
  findByExternalMessageId?(input: TranscriptExternalMessageLookup): Promise<TranscriptMessage | undefined>;
}

export interface TranscriptExternalMessageLookup {
  readonly platform: string;
  readonly provider: string;
  readonly channelId: string;
  readonly conversationType: ConversationType;
  readonly conversationId: string;
  readonly externalMessageId: string;
}
