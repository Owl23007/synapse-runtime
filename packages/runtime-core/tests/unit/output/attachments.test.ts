import { describe, expect, it } from "vitest";
import { ResponsePolicy } from "../../../src/output/policy.js";

describe("展示交付隔离", () => {
  it("限制文本且不丢失或改写已确认附件", () => {
    const file = { type: "file" as const, name: "demo.pptx", url: "base64://aGk=" };
    const result = new ResponsePolicy().apply(
      { type: "mixed", segments: [{ type: "text", text: "**完成**" }, file] },
      { mode: "concise", maxChars: 1, allowMarkdown: false, allowCodeBlock: false, appendExpandHint: false }
    );
    expect(result.segments).toEqual([{ type: "text", text: "完" }, file]);
    expect(result.segments[1]).toBe(file);
  });
});
