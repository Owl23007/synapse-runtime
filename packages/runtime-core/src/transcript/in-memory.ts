import { normalizeMessageId } from "../context/session.js";
import type {
  TranscriptAppendInput,
  TranscriptExternalMessageLookup,
  TranscriptMessage,
  TranscriptStore
} from "./types.js";

export class InMemoryTranscriptStore implements TranscriptStore {
  readonly #messages: TranscriptMessage[] = [];
  readonly #sourceIndex = new Map<string, TranscriptMessage>();

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const sourceKey = input.sourceEventId === undefined ? undefined : transcriptSourceKey(input);
    const existing = sourceKey === undefined ? undefined : this.#sourceIndex.get(sourceKey);

    if (existing !== undefined) {
      return existing;
    }

    const message: TranscriptMessage = {
      id: `msg-${this.#messages.length + 1}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input
    };
    this.#messages.push(message);

    if (sourceKey !== undefined) {
      this.#sourceIndex.set(sourceKey, message);
    }

    return message;
  }

  async listRecent(
    sessionId: string,
    options: { readonly limit?: number } = {}
  ): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;

    return this.#messages
      .filter((message) => message.sessionId === sessionId && message.deletedAt === undefined)
      .slice(-limit);
  }

  async findByExternalMessageId(input: TranscriptExternalMessageLookup): Promise<TranscriptMessage | undefined> {
    const externalMessageId = normalizeMessageId(input.externalMessageId);
    if (externalMessageId === undefined) {
      return undefined;
    }

    return this.#messages.find(
      (message) =>
        message.platform === input.platform &&
        message.provider === input.provider &&
        message.channelId === input.channelId &&
        message.conversationType === input.conversationType &&
        message.conversationId === input.conversationId &&
        message.role === "assistant" &&
        normalizeMessageId(message.externalMessageId) === externalMessageId
    );
  }
}

function transcriptSourceKey(input: TranscriptAppendInput): string {
  return [
    input.platform,
    input.provider,
    input.channelId,
    input.conversationType,
    input.conversationId,
    input.sourceEventId
  ].join(":");
}
