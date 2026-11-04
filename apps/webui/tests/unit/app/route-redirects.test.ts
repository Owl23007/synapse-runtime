import { describe, expect, it } from "vitest";
import { NAV_ITEMS, PAGE_ITEMS, resolveRoute } from "../../../src/app/routes.js";

describe("首页重定向与主导航", () => {
  it.each(["", "#", "#/", "/", "#/overview"])("%s 直接解析为工作空间页面", (hash) => {
    expect(resolveRoute(hash)).toMatchObject({
      key: "/workspace",
      section: "workspace",
      id: undefined
    });
  });

  it("重定向保留会话和分支参数的原始编码", () => {
    const query = "session=qq%3Agroup%3A42&line=branch%2Fone&q=a%20b";
    const route = resolveRoute(`#/?${query}`);
    expect(route.key).toBe(`/workspace?${query}`);
    expect(route.query.get("session")).toBe("qq:group:42");
    expect(route.query.get("line")).toBe("branch/one");
    expect(route.query.get("q")).toBe("a b");
    expect(resolveRoute(`#/overview?${query}`).key).toBe(route.key);
  });

  it("移除数据浏览与总览导航，保留会话数据深链接", () => {
    expect(NAV_ITEMS.map((item) => item.section)).toEqual(["workspace", "runs", "files", "capabilities", "tasks"]);
    expect(PAGE_ITEMS.some((item) => item.path === ("/" as string))).toBe(false);
    const route = resolveRoute("#/explorer?session=qq%3Agroup%3A42");
    expect(route.section).toBe("explorer");
    expect(route.query.get("session")).toBe("qq:group:42");
  });

  it("保持运行详情、筛选和未知地址的路由行为", () => {
    expect(resolveRoute("#/runs/run%252Fid")).toMatchObject({ section: "runs", id: "run%2Fid" });
    expect(resolveRoute("#/runs?status=failed").query.get("status")).toBe("failed");
    for (const hash of ["#/unknown", "#/overview/extra", "#/runs/%bad"])
      expect(resolveRoute(hash).section).toBe("not-found");
  });
});
