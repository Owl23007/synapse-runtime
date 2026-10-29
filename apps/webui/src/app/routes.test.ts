import { describe, expect, it } from "vitest";
import { parseRoute } from "./routes.js";

describe("页面深链接", () => {
  it("保留会话、分支与筛选值中的编码字符", () => {
    const route = parseRoute("#/workspace?session=qq%3Anapcat%3Agroup%3A42&line=branch%2Fone");
    expect(route.section).toBe("workspace");
    expect(route.query.get("session")).toBe("qq:napcat:group:42");
    expect(route.query.get("line")).toBe("branch/one");
    expect(parseRoute("#/runs?status=failed&sessionId=a%26b").query.get("sessionId")).toBe("a&b");
  });

  it("运行标识只解码一次，损坏转义保持在不存在页面", () => {
    expect(parseRoute("#/runs/run%252Fid").id).toBe("run%2Fid");
    expect(parseRoute("#/runs/%bad").section).toBe("not-found");
    expect(parseRoute("#/workspace/extra").section).toBe("not-found");
    expect(parseRoute("#/unknown").section).toBe("not-found");
    expect(parseRoute("").section).toBe("overview");
  });
});
