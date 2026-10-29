import { describe, expect, it } from "vitest";
import { workspaceMessageText } from "./model.js";

describe("历史消息内容", () => {
  it("保留普通文本和分支摘要，未知载荷不直接渲染", () => {
    expect(workspaceMessageText({ text: "用户输入", summary: "摘要" })).toBe("用户输入");
    expect(workspaceMessageText({ text: "", summary: "分支结果" })).toBe("分支结果");
    for (const value of [undefined, null, 1, [], {}, { text: { bad: true } }, { summary: ["bad"] }])
      expect(workspaceMessageText(value)).toBe("[附件消息]");
  });

  it("旧服务器的截断载荷有可读提示", () => {
    expect(workspaceMessageText("[TRUNCATED]")).toBe("[消息内容已截断]");
    expect(workspaceMessageText({ _truncated: true })).toBe("[消息内容已截断]");
  });
});
