import { textMessage } from "@synapse/runtime-protocol";
import { describe, expect, it } from "vitest";
import { ResponsePolicy } from "../../../src/output/policy.js";

const privatePolicy = {
  mode: "normal" as const,
  maxChars: 4000,
  allowMarkdown: true,
  allowCodeBlock: true,
  appendExpandHint: false
};

describe("回复策略展示隔离", () => {
  it("规范输出后应用确定性展示限制", () => {
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

  it("不允许展示配置放宽通道约束", () => {
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

  it("忽略禁用的展示配置", () => {
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
