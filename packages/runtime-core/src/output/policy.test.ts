import { textMessage } from "@synapse/runtime-protocol";
import { describe, expect, it } from "vitest";
import { ResponsePolicy } from "./policy.js";

const privatePolicy = {
  mode: "normal" as const,
  maxChars: 4000,
  allowMarkdown: true,
  allowCodeBlock: true,
  appendExpandHint: false
};

describe("ResponsePolicy presentation isolation", () => {
  it("applies deterministic profile limits after canonical output", () => {
    const policy = new ResponsePolicy({
      id: "concise",
      locale: "zh-CN",
      enabled: true,
      maxChars: 100,
      maxParagraphs: 2,
      allowMarkdown: false,
      allowCodeBlock: false
    });

    expect(policy.apply(textMessage("# 标题\n\n第一段 **重点**\n\n第二段\n\n第三段"), privatePolicy).segments).toEqual([
      { type: "text", text: "标题\n\n第一段 重点" }
    ]);
  });

  it("does not let a profile loosen channel constraints", () => {
    const policy = new ResponsePolicy({
      id: "loose",
      locale: "zh-CN",
      enabled: true,
      maxChars: 1000,
      allowMarkdown: true,
      allowCodeBlock: true
    });

    expect(
      policy.apply(textMessage("**结果**"), { ...privatePolicy, maxChars: 4, allowMarkdown: false }).segments
    ).toEqual([{ type: "text", text: "结果" }]);
  });

  it("ignores disabled profiles", () => {
    const policy = new ResponsePolicy({
      id: "disabled",
      locale: "zh-CN",
      enabled: false,
      maxParagraphs: 1
    });

    expect(policy.apply(textMessage("第一段\n\n第二段"), privatePolicy).segments).toEqual([
      { type: "text", text: "第一段\n\n第二段" }
    ]);
  });
});
