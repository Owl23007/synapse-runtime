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

test("新对话直接发送首条消息，失败重试沿用会话与运行幂等键", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-new-conversation-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/new-conversation");
  await mkdir(screenshots, { recursive: true });
  const server = new RuntimeServer({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, token: "new-conversation-test-only" }
    }),
    logger: { info() {}, warn() {}, error() {} }
  });
  let browser;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "new-conversation-test-only" });
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1585, height: 1000 } });
    const errors = [];
    const creates = [];
    const submissions = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/admin/sessions")
        creates.push(request.postDataJSON());
    });
    // 首次运行提交失败后仍由真实创建接口与幂等协议恢复，不重新种入会话
    await page.route("**/admin/runs", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "temporary_unavailable" })
        });
      return route.continue();
    });
    await page.goto(`${endpoint}/#/workspace`);
    await page.getByLabel("访问令牌").fill("new-conversation-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("heading", { name: "开始新的会话", exact: true })).toBeVisible();
    const input = page.getByRole("textbox", { name: "发送给 Agent 的消息" });
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    await expect(input).toBeFocused();
    await expect(send).toBeDisabled();
    await expect(page.locator(".workspace-content input")).toHaveCount(0);
    await input.fill("   ");
    await expect(send).toBeDisabled();
    await input.fill("分析项目依赖");
    await input.press("Shift+Enter");
    await input.pressSequentially("整理核心模块");
    const content = "分析项目依赖\n整理核心模块";
    await expect(input).toHaveValue(content);
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(content);
    assert.equal((await client.sessions()).items.length, 0);
    assert.equal(creates.length, 0);
    await input.fill("");
    await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true, animations: "disabled" });
    await input.fill(content);
    await input.press("Enter");
    await expect(page.getByRole("alert")).toContainText("503");
    await expect(input).toHaveValue(content);
    await expect(send).toBeEnabled();
    assert.equal((await client.sessions()).items.length, 1);
    await send.click();
    await expect(page.getByRole("heading", { name: "分析项目依赖 整理核心模块", exact: true })).toBeVisible();
    await expect(page.locator(".chat-message.user .message-text")).toHaveText(content);
    await expect(page.locator(".chat-message")).toHaveCount(2);
    assert.equal((await client.sessions()).items.length, 1);
    assert.equal((await client.runs()).items.length, 1);
    assert.equal(creates.length, 2);
    assert.equal(creates[0].idempotencyKey, creates[1].idempotencyKey);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(submissions[0].text, content);
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    assert.equal((await client.sessions()).items.length, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await input.fill("移动端直接发送");
    await send.click();
    await expect(page.getByRole("heading", { name: "移动端直接发送", exact: true })).toBeVisible();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    assert.equal((await client.sessions()).items.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
