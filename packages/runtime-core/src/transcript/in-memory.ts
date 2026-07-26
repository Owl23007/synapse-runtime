import { normalizeMessageId } from "../context/session.js";
import type {
  TranscriptAppendInput,
  TranscriptExternalMessageLookup,
  TranscriptListRecentOptions,
  TranscriptMessage,
  TranscriptStore
} from "./types.js";

export class InMemoryTranscriptStore implements TranscriptStore {
  readonly #messages: TranscriptMessage[] = [];
  readonly #sourceIndex = new Map<string, TranscriptMessage>();
  readonly #idempotencyIndex = new Map<string, TranscriptMessage>();

  async append(input: TranscriptAppendInput): Promise<TranscriptMessage> {
    const idempotencyKey = input.idempotencyKey === undefined ? undefined : transcriptIdempotencyKey(input);
    const idempotent = idempotencyKey === undefined ? undefined : this.#idempotencyIndex.get(idempotencyKey);
    if (idempotent !== undefined) {
      return cloneTranscript(idempotent);
    }

    const sourceKey = input.sourceEventId === undefined ? undefined : transcriptSourceKey(input);
    const existing = sourceKey === undefined ? undefined : this.#sourceIndex.get(sourceKey);

    if (existing !== undefined) {
      return cloneTranscript(existing);
    }

    const message = cloneTranscript<TranscriptMessage>({
      id: `msg-${this.#messages.length + 1}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input
    });
    this.#messages.push(message);

    if (sourceKey !== undefined) {
      this.#sourceIndex.set(sourceKey, message);
    }
    if (idempotencyKey !== undefined) {
      this.#idempotencyIndex.set(idempotencyKey, message);
    }

    return cloneTranscript(message);
  }

  async listRecent(
    sessionId: string,
    options: TranscriptListRecentOptions = {}
  ): Promise<readonly TranscriptMessage[]> {
    const limit = options.limit ?? 20;

    return cloneTranscript(
      this.#messages
        .filter(
          (message) =>
            message.sessionId === sessionId &&
            message.deletedAt === undefined &&
            (options.lineId === undefined || message.lineId === options.lineId)
        )
        .slice(-limit)
    );
  }

  async findByExternalMessageId(input: TranscriptExternalMessageLookup): Promise<TranscriptMessage | undefined> {
    const externalMessageId = normalizeMessageId(input.externalMessageId);
    if (externalMessageId === undefined) {
      return undefined;
    }

    return cloneTranscriptOptional(
      this.#messages.find(
        (message) =>
          message.platform === input.platform &&
          message.provider === input.provider &&
          message.channelId === input.channelId &&
          message.conversationType === input.conversationType &&
          message.conversationId === input.conversationId &&
          message.role === "assistant" &&
          normalizeMessageId(message.externalMessageId) === externalMessageId
      )
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
    input.sourceEventId,
    input.eventType ?? input.role
  ].join("\u001f");
}

function transcriptIdempotencyKey(input: TranscriptAppendInput): string {
  return [input.sessionId, input.lineId ?? "", input.idempotencyKey].join("\u001f");
}

function cloneTranscript<T>(value: T): T {
  return structuredClone(value);
}

function cloneTranscriptOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneTranscript(value);
}
