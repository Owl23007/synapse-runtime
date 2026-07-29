import type { MessageSegment, SynapseMessage } from "./types.js";

/**
 * 创建仅包含文本片段的规范消息
 */
export function textMessage(text: string, id?: string): SynapseMessage {
  return {
    ...(id === undefined ? {} : { id }),
    type: "text",
    segments: [{ type: "text", text }]
  };
}

/**
 * 提取规范消息中的全部文本内容
 */
export function getTextContent(message: SynapseMessage): string {
  return message.segments
    .filter((segment): segment is Extract<MessageSegment, { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");
}
