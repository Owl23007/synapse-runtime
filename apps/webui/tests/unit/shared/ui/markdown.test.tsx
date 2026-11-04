import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, previewDocument } from "../../../../src/shared/ui/markdown.js";

it("渲染表格、任务列表和未闭合代码块，原始 HTML 与危险 URL 不会执行", () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={
        "# 标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] 完成\n\n<script>alert(1)</script>\n\n[链接](javascript:alert(1))\n\n```html\n<h1>预览</h1>"
      }
    />
  );
  expect(html).toContain("<h1>标题</h1>");
  expect(html).toContain("<table>");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("复制代码");
  expect(html).toContain("预览");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
});
it("预览内容在文档开头声明禁止脚本和外部加载的策略", () => {
  const document = previewDocument("<script>alert(1)</script><h1>预览</h1>");
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<script>"));
  expect(document).toContain("default-src 'none'");
  expect(document).not.toContain("script-src 'unsafe-inline'");
});
