import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");
const { createServer } = requireWebUi("vite");

test("设计系统材质、键盘浮层与系统降级使用实际组件", { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, "../apps/webui");
  const screenshots = resolve(import.meta.dirname, "../test-results/design-system");
  await mkdir(screenshots, { recursive: true });
  const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await server.listen();
    const endpoint = server.resolvedUrls.local[0];
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1200, height: 920 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${endpoint}design-system.html`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { name: "标准卡片" })).toBeVisible();
    assert.equal(await page.locator(".surface-liquid .material-filter").count(), 0);
    await expect(page.locator(".surface-frosted.specimen-card")).toHaveCSS("backdrop-filter", "blur(18px)");
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await expect(page.locator("output")).toHaveText("110%");
    await page.screenshot({ path: join(screenshots, "materials.png"), fullPage: true });
    await page.getByRole("button", { name: "外观设置" }).click();
    await page.getByLabel("浮层材质").selectOption("refracted");
    await expect(page.locator(".surface-liquid .material-filter")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "外观设置" })).toBeFocused();
    await page.screenshot({ path: join(screenshots, "refraction.png"), fullPage: true });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }]
    });
    await expect(page.locator(".surface-liquid")).toHaveCSS("backdrop-filter", "none");
    await expect(page.locator(".surface-frosted.specimen-card")).toHaveCSS("backdrop-filter", "none");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".surface-liquid")).toHaveCSS("backdrop-filter", "none");
    await expect(page.locator(".loading"), "低动画偏好停止旋转").toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "外观设置" }).click();
    await page.getByLabel("浮层材质").selectOption("solid");
    await expect(page.locator(".surface-liquid")).toHaveCSS("backdrop-filter", "none");
    await expect(page.locator(".surface-frosted.specimen-card")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(screenshots, "mobile-materials.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("真实会话支持跳转焦点、标签键盘导航和缩放平移", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-design-a11y-"));
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "design-test-only" }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  try {
    const listening = await server.start();
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${listening.admin.port}`);
    await page.getByLabel("访问令牌").fill("design-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await page.getByRole("link", { name: "会话工作台", exact: true }).click();
    await page.getByLabel("新会话名称").fill("键盘操作验收");
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "键盘操作验收", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "对话", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "上下文 DAG" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "上下文 DAG" })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("上下文 DAG 画布").focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "放大画布" }).click();
    await expect(page.getByLabel("画布缩放比例")).toHaveText("115%");
    await page.getByRole("tab", { name: "上下文 DAG" }).focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "工件", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "对话", exact: true })).toBeFocused();
    const route = await page.evaluate(() => location.hash);
    await page.getByRole("link", { name: "跳到主要内容" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    assert.equal(await page.evaluate(() => location.hash), route);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
