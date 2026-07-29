import { ConversationStoreError } from "./errors.js";
import type {
  AcceptNormalizedEventInput,
  AppendLineEventInput,
  CreateBranchInput,
  CreateBranchResultInput,
  CreateConversationNodeInput,
  CreateSessionInput,
  CreateTaskInput,
  ListConversationNodesOptions,
  ListLineEventsOptions
} from "./types.js";

/** 从创建参数解析会话标识 */
export function sessionIdFromInput(input: CreateSessionInput): string {
  const id = input.id ?? input.sessionId;
  if (id === undefined || id.trim().length === 0) {
    throw validationError("createSession requires a non-empty id or sessionId.");
  }
  if (input.id !== undefined && input.sessionId !== undefined && input.id !== input.sessionId) {
    throw validationError("createSession id and sessionId aliases must match when both are provided.");
  }
  return id;
}

/** 校验内存会话创建参数 */
export function validateCreateSessionInput(input: CreateSessionInput): void {
  sessionIdFromInput(input);
  if (input.mainlineId !== undefined) {
    validateNonEmpty("mainlineId", input.mainlineId);
  }
  if (input.idempotencyKey !== undefined) {
    validateIdempotencyKey(input.idempotencyKey);
  }
}

/** 校验内存规范化事件参数 */
export function validateAcceptNormalizedEventInput(input: AcceptNormalizedEventInput): void {
  for (const [name, value] of [
    ["sessionId", input.sessionId],
    ["platform", input.platform],
    ["provider", input.provider],
    ["channelId", input.channelId],
    ["conversationType", input.conversationType],
    ["conversationId", input.conversationId],
    ["sourceEventId", input.sourceEventId],
    ["sourceEventType", input.sourceEventType],
    ["senderId", input.senderId],
    ["receivedAt", input.receivedAt]
  ] as const) {
    validateNonEmpty(name, value);
  }
  validateIdempotencyKey(input.idempotencyKey);
}

/** 校验内存分支创建参数 */
export function validateCreateBranchInput(input: CreateBranchInput): void {
  for (const [name, value] of [
    ["sessionId", input.sessionId],
    ["sourceEventId", input.sourceEventId],
    ["title", input.title],
    ["goal", input.goal],
    ["reason", input.reason],
    ["createdBy", input.createdBy]
  ] as const) {
    validateNonEmpty(name, value);
  }
  validateIdempotencyKey(input.idempotencyKey);
}

/** 校验内存事件追加参数 */
export function validateAppendLineEventInput(input: AppendLineEventInput): void {
  validateNonEmpty("event type", input.type);
  validateIdempotencyKey(input.idempotencyKey);
}

/** 校验内存任务创建参数 */
export function validateCreateTaskInput(input: CreateTaskInput): void {
  validateNonEmpty("executor", input.executor);
  validateIdempotencyKey(input.idempotencyKey);
}

/** 校验内存分支结果创建参数 */
export function validateCreateBranchResultInput(input: CreateBranchResultInput): void {
  validateNonEmpty("summary", input.summary);
  validateIdempotencyKey(input.idempotencyKey);
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version <= 0)) {
    throw validationError("Branch result version must be a positive safe integer.");
  }
}

/** 校验内存会话节点创建参数 */
export function validateCreateConversationNodeInput(input: CreateConversationNodeInput): void {
  validateNonEmpty("node kind", input.kind);
  validateNonEmpty("title", input.title);
  validateNonEmpty("createdBy", input.createdBy);
  validateIdempotencyKey(input.idempotencyKey);
  if (input.statePatch === null || typeof input.statePatch !== "object" || Array.isArray(input.statePatch)) {
    throw validationError("Conversation node statePatch must be an object.");
  }
}

/** 校验内存会话节点列表参数 */
export function validateListConversationNodesOptions(options: ListConversationNodesOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw validationError("Node list limit must be a positive safe integer.");
  }
  for (const [name, value] of [
    ["afterOrdinal", options.afterOrdinal],
    ["beforeOrdinal", options.beforeOrdinal]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw validationError(`${name} must be a non-negative safe integer.`);
    }
  }
}

/** 校验内存会话事件列表参数 */
export function validateListOptions(options: ListLineEventsOptions): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw validationError("Event list limit must be a positive safe integer.");
  }
  for (const [name, value] of [
    ["afterSequence", options.afterSequence],
    ["beforeSequence", options.beforeSequence]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw validationError(`${name} must be a non-negative safe integer.`);
    }
  }
}

/** 校验内存幂等键 */
export function validateIdempotencyKey(value: string): void {
  validateNonEmpty("idempotencyKey", value);
}

/** 校验字符串不为空 */
export function validateNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw validationError(`${name} must not be empty.`);
  }
}

function validationError(message: string): ConversationStoreError {
  return new ConversationStoreError("validation_error", message);
}
