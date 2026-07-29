import { ConversationStoreError } from "../../conversation/errors.js";

type EncodedJson =
  | readonly ["null"]
  | readonly ["boolean", boolean]
  | readonly ["number", number]
  | readonly ["string", string]
  | readonly ["bigint", string]
  | readonly ["array", readonly EncodedJson[]]
  | readonly ["object", readonly (readonly [string, EncodedJson])[]];

const JSON_CODEC_KEY = "__synapse_runtime_json_v1__";

/** 将可选值编码为 SQLite 可持久化文本 */
export function encodeOptionalJson(value: unknown, label: string): string | null {
  return value === undefined ? null : encodeRequiredJson(value, label);
}

/** 将必填值编码为 SQLite 可持久化文本 */
export function encodeRequiredJson(value: unknown, label: string): string {
  if (value === undefined) {
    throw new ConversationStoreError("validation_error", `${label} cannot be undefined.`);
  }
  const encoded = encodeJsonValue(value, label, new WeakSet<object>());
  return JSON.stringify({ [JSON_CODEC_KEY]: encoded });
}

function encodeJsonValue(value: unknown, label: string, ancestors: WeakSet<object>): EncodedJson {
  if (value === null) {
    return ["null"];
  }
  if (typeof value === "string") {
    return ["string", value];
  }
  if (typeof value === "boolean") {
    return ["boolean", value];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConversationStoreError("validation_error", `${label} contains a non-finite number.`);
    }
    return ["number", value];
  }
  if (typeof value === "bigint") {
    return ["bigint", value.toString()];
  }
  if (typeof value !== "object") {
    throw new ConversationStoreError("validation_error", `${label} contains a value that JSON cannot serialize.`);
  }
  if (ancestors.has(value)) {
    throw new ConversationStoreError("validation_error", `${label} contains a circular reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: EncodedJson[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new ConversationStoreError("validation_error", `${label} contains a sparse array.`);
        }
        result.push(encodeJsonValue(value[index], label, ancestors));
      }
      return ["array", result];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConversationStoreError("validation_error", `${label} contains a non-JSON object.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ConversationStoreError("validation_error", `${label} contains symbol properties.`);
    }
    const record = value as Record<string, unknown>;
    return [
      "object",
      Object.keys(record)
        .toSorted()
        .map((key) => [key, encodeJsonValue(record[key], label, ancestors)] as const)
    ];
  } finally {
    ancestors.delete(value);
  }
}

/** 解码 SQLite 中保存的结构化值 */
export function decodeJson<T = unknown>(serialized: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new ConversationStoreError("conflict", `Stored ${label} is not valid JSON.`);
  }
  if (typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, JSON_CODEC_KEY)) {
    return decodeJsonValue((parsed as Record<string, unknown>)[JSON_CODEC_KEY], label) as T;
  }
  // 兼容 v1 迁移生成的普通 JSON 数据
  return parsed as T;
}

function decodeJsonValue(encoded: unknown, label: string): unknown {
  if (!Array.isArray(encoded) || typeof encoded[0] !== "string") {
    throw new ConversationStoreError("conflict", `Stored ${label} uses an invalid JSON encoding.`);
  }
  switch (encoded[0]) {
    case "null":
      return null;
    case "boolean":
    case "number":
    case "string":
      return encoded[1];
    case "bigint":
      if (typeof encoded[1] !== "string") {
        break;
      }
      try {
        return BigInt(encoded[1]);
      } catch {
        break;
      }
    case "array":
      if (Array.isArray(encoded[1])) {
        return encoded[1].map((item) => decodeJsonValue(item, label));
      }
      break;
    case "object":
      if (Array.isArray(encoded[1])) {
        const result: Record<string, unknown> = {};
        for (const entry of encoded[1]) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string") {
            throw new ConversationStoreError("conflict", `Stored ${label} uses an invalid object encoding.`);
          }
          result[entry[0]] = decodeJsonValue(entry[1], label);
        }
        return result;
      }
      break;
  }
  throw new ConversationStoreError("conflict", `Stored ${label} uses an invalid JSON encoding.`);
}

/** 比较两个可持久化结构化值是否一致 */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return encodeRequiredJson(left, "idempotency value") === encodeRequiredJson(right, "idempotency value");
}
