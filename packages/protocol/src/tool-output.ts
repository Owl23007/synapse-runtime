import type { MessageSegment } from "./types.js";

/** 工具生成的真实附件，生产环境使用 artifact 引用，旧 Base64 仅兼容传输边界 */
export interface ToolOutput {
  readonly schemaVersion: "runtime-tool-output/v1";
  readonly modelOutput: unknown;
  readonly attachments: readonly MessageSegment[];
}

/** 识别受版本约束的工具交付结果，避免把普通工具 JSON 误识别为附件 */
export function readToolOutput(value: unknown): ToolOutput | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "runtime-tool-output/v1"
  )
    return undefined;
  if (
    !("modelOutput" in value) ||
    !("attachments" in value) ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 8
  )
    return undefined;
  if (
    !value.attachments.every((part: unknown) => {
      if (
        typeof part !== "object" ||
        part === null ||
        !("type" in part) ||
        !("url" in part) ||
        typeof part.url !== "string" ||
        (!/^base64:\/\/[A-Za-z0-9+/]*={0,2}$/.test(part.url) &&
          !/^artifact:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part.url))
      )
        return false;
      return (
        part.type === "image" ||
        (part.type === "file" && "name" in part && typeof part.name === "string" && part.name.length > 0)
      );
    })
  )
    return undefined;
  return value as ToolOutput;
}
