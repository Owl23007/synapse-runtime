import { describe, expect, it } from "vitest";
import { ResponsePolicy } from "./policy.js";

describe("presentation delivery isolation", () => {
  it("limits text without losing or rewriting confirmed attachments", () => {
    const file = { type: "file" as const, name: "demo.pptx", url: "base64://aGk=" };
    const result = new ResponsePolicy().apply(
      { type: "mixed", segments: [{ type: "text", text: "**完成**" }, file] },
      { mode: "concise", maxChars: 1, allowMarkdown: false, allowCodeBlock: false, appendExpandHint: false }
    );
    expect(result.segments).toEqual([{ type: "text", text: "完" }, file]);
    expect(result.segments[1]).toBe(file);
  });
});
