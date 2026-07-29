import type { ConversationStoreErrorCode } from "./types.js";

/**
 * 会话存储违反领域约束时抛出的错误
 */
export class ConversationStoreError extends Error {
  readonly code: ConversationStoreErrorCode;

  constructor(code: ConversationStoreErrorCode, message: string) {
    super(message);
    this.name = "ConversationStoreError";
    this.code = code;
  }
}
