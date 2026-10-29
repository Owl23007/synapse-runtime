import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");
const { createServer } = requireWebUi("vite");

async function send(page, tone, text, duration = 0) {
  await page.evaluate(
    async (input) => {
      const { toast } = await import("/src/shared/lib/toast.ts");
      toast[input.tone](input.text, { duration: input.duration });
    },
    { tone, text, duration }
  );
}

async function clear(page) {
  await page.evaluate(async () => {
    const { toast } = await import("/src/shared/lib/toast.ts");
    toast.clear();
  });
  await expect(page.locator(".toast")).toHaveCount(0);
}

test("全局消息居中浮空且不抢焦点，支持去重、暂停计时与移动端降级", { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, "../apps/webui");
  const screenshots = resolve(import.meta.dirname, "../test-results/toasts");
  await mkdir(screenshots, { recursive: true });
  const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await server.listen();
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.evaluate(() => document.fonts.ready);
    const input = page.getByLabel("访问令牌", { exact: false });
    await input.focus();
    await send(page, "success", "已复制消息");
    await expect(page.locator(".toast")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.locator(".toast")).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".toast-viewport")).toHaveCSS("pointer-events", "none");
    await expect(page.locator(".toast")).toHaveCSS("pointer-events", "auto");
    const box = await page.locator(".toast-viewport").boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - 720) < 1);
    assert.ok(Math.abs(box.y + box.height / 2 - 500) < 1);
    await expect(page.locator(".toast")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true });

    await send(page, "success", "已复制消息");
    await expect(page.locator(".toast")).toHaveCount(1);
    await send(page, "info", "配置已更新");
    await send(page, "warning", "连接正在恢复");
    await send(page, "error", "操作失败，请稍后重试");
    await expect(page.locator(".toast")).toHaveCount(3);
    await expect(page.getByRole("alert")).toContainText("操作失败");
    await expect(page.locator(".toast-success")).toHaveCount(0);
    await page.locator(".toast-error").getByRole("button", { name: "关闭提醒" }).click();
    await expect(page.locator(".toast-error")).toHaveCount(0);
    await clear(page);

    await page.clock.install();
    await send(page, "info", "计时提醒", 1000);
    const card = page.locator(".toast");
    await expect(card).toBeVisible();
    await page.clock.runFor(400);
    await card.hover();
    await page.clock.runFor(2000);
    await expect(card).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(400);
    await expect(card).toBeVisible();
    await page.clock.runFor(500);
    await expect(card).toHaveCount(0);

    await send(page, "warning", "键盘阅读提醒", 1000);
    await card.getByRole("button", { name: "关闭提醒" }).focus();
    await page.clock.runFor(2000);
    await expect(card).toBeVisible();
    await input.focus();
    await page.clock.runFor(1300);
    await expect(card).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await send(page, "warning", "服务暂不可用，请检查连接地址后重试。".repeat(8));
    await page.clock.runFor(200);
    await expect(card).toHaveCSS("opacity", "1");
    const mobile = await card.boundingBox();
    assert.ok(mobile.x >= 16 && mobile.x + mobile.width <= 374);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }]
    });
    await expect(card).toHaveCSS("backdrop-filter", "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(card).toHaveCSS("animation-name", "none");
    await card.getByRole("button", { name: "关闭提醒" }).click();
    await page.clock.runFor(200);
    await expect(card).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
