import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { RuntimeAdminClient } from "../packages/runtime-client/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("工作台左栏支持独立折叠、拖动分区、键盘恢复与窄屏切换", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-workspace-panels-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/workspace-panels");
  await mkdir(screenshots, { recursive: true });
  const server = new RuntimeServer({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, token: "panels-test-only" }
    }),
    logger: { info() {}, warn() {}, error() {} }
  });
  let browser;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "panels-test-only" });
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => client.createSession(`历史会话 ${index}`, `history-${index}`))
    );
    const { session } = await client.createSession("分栏交互验证", "session");
    const { run } = await client.submitRun({ sessionId: session.id, text: "验证上下文历史", idempotencyKey: "run" });
    await expect.poll(async () => (await client.run(run.id)).run.status).toBe("succeeded");
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1584, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${endpoint}/#/workspace?session=${encodeURIComponent(session.id)}`);
    await page.getByLabel("访问令牌").fill("panels-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("heading", { name: "分栏交互验证", exact: true })).toBeVisible();
    await expect(page.locator(".session-row")).toHaveCount(25);
    await expect(page.locator(".sidebar nav").getByRole("button", { name: "收起导航" })).toBeVisible();
    await expect(page.locator(".sidebar-header button")).toHaveCount(0);
    const separator = page.getByRole("separator", { name: "调整会话与上下文高度" });
    const context = page.getByLabel("上下文历史", { exact: true });
    const initialContextHeight = (await context.boundingBox()).height;
    const bounds = await separator.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 120, bounds.y - 100, { steps: 8 });
    await page.mouse.up();
    assert.ok(Number(await separator.getAttribute("aria-valuenow")) < 70);
    assert.ok((await context.boundingBox()).height > initialContextHeight + 50);
    await expect(page.locator(".session-pane")).not.toHaveClass(/is-resizing/);
    await separator.focus();
    await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "30");
    await page.keyboard.press("ArrowDown");
    await expect(separator).toHaveAttribute("aria-valuenow", "35");
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "80");
    await separator.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", "70");

    await page.getByRole("button", { name: "折叠上下文", exact: true }).click();
    await expect(page.getByLabel("提交历史", { exact: true })).toBeHidden();
    await expect(separator).toHaveCount(0);
    await page.getByRole("button", { name: "展开上下文", exact: true }).click();
    await expect(separator).toHaveAttribute("aria-valuenow", "70");
    const list = page.getByLabel("会话列表", { exact: true });
    const scrollTop = await list.evaluate((element) => (element.scrollTop = 120));
    await page.getByRole("button", { name: "折叠会话分组", exact: true }).click();
    await expect(page.getByLabel("搜索会话")).toBeHidden();
    assert.ok((await context.boundingBox()).height > initialContextHeight + 200);
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("搜索会话")).toBeFocused();
    assert.equal(await list.evaluate((element) => element.scrollTop), scrollTop);
    await page.getByRole("button", { name: "收起会话列表", exact: true }).click();
    await expect(page.getByLabel("会话与上下文", { exact: true })).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("搜索会话")).toBeFocused();
    await expect(separator).toHaveAttribute("aria-valuenow", "70");
    await page.screenshot({ path: join(screenshots, "panels.png"), fullPage: true });

    await page.getByRole("button", { name: "收起导航", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "72px");
    await expect(page.getByRole("button", { name: "展开导航", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".main-shell")).toHaveCSS("margin-left", "0px");
    await expect(page.locator(".sidebar .brand .sidebar-label")).toHaveCSS("opacity", "1");
    await expect(page.locator(".session-pane")).toBeHidden();
    await page.getByRole("button", { name: "展开会话列表", exact: true }).click();
    await expect(page.getByLabel("搜索会话")).toBeVisible();
    await expect(separator).toBeHidden();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(screenshots, "panels-mobile.png"), fullPage: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1584, height: 1000 });
    await page.getByRole("button", { name: "展开导航", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "224px");
    await expect(page.locator(".sidebar")).toHaveCSS("transition-property", "none");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
