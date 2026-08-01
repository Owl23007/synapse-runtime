import { createHash } from "node:crypto";
import type { Tool } from "./types.js";

/** 工具集合的规范化摘要及其稳定排序结果 */
export interface ToolSetDescriptor {
  readonly toolIds: readonly string[];
  readonly digest: string;
}

/**
 * 根据工具名称、描述和输入 Schema 计算与注册顺序无关的稳定摘要
 *
 * 权限结果不在 Tool 定义中，调用方需要在权限过滤后对最终可见集合计算摘要
 */
export function describeToolSet(tools: readonly Tool[]): ToolSetDescriptor {
  const normalized = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true }
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name, "en"));
  return {
    toolIds: normalized.map((tool) => tool.name),
    digest: createHash("sha256").update(canonicalJson(normalized)).digest("hex")
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).toSorted(([left], [right]) =>
      left.localeCompare(right, "en")
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
