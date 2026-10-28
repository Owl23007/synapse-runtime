import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("WebUI 原生会话完成输入、执行、历史分叉、比较与合并，并支持移动布局", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-workspace-browser-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/workspace");
  await mkdir(screenshots, { recursive: true });
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "workspace-test-only" }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(endpoint);
    await page.getByLabel("访问令牌").fill("workspace-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await page.getByRole("link", { name: "会话工作台", exact: true }).click();
    await page.getByLabel("新会话名称").fill("产品发布计划");
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "产品发布计划", exact: true })).toBeVisible();
    await page.getByLabel("发送给 Agent 的消息").fill("制定产品发布计划，优先完成用户体验和核心工作流");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await expect(page.locator(".running-strip")).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "conversation.png"), fullPage: true });
    await page.getByRole("tab", { name: "上下文 DAG" }).click();
    await expect(page.locator(".dag-node")).toHaveCount(4);
    await page.locator(".dag-node.input").click();
    await expect(page.getByRole("link", { name: "查看关联运行" })).toBeVisible();
    await page.getByLabel("新分支名称").fill("体验优化方案");
    await page.screenshot({ path: join(screenshots, "history-node.png"), fullPage: true });
    await page.getByRole("button", { name: "从此节点分叉" }).click();
    await expect(page.getByLabel("当前分支").locator("option:checked")).toHaveText("体验优化方案");
    await page.getByLabel("发送给 Agent 的消息").fill("先开展小规模体验测试，再逐步开放发布");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await expect(page.locator(".running-strip")).toHaveCount(0);
    await page.getByRole("button", { name: "比较与合并" }).click();
    await expect(page.locator(".compare-grid")).toContainText("先开展小规模体验测试");
    await page.getByRole("button", { name: "确认合并结果" }).click();
    await expect(page.getByText("分支结果已合并到主线", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "适应画布" }).click();
    await page.screenshot({ path: join(screenshots, "dag-merged.png"), fullPage: true });
    const mainline = await page.getByLabel("当前分支").locator("option").first().getAttribute("value");
    await page.getByLabel("当前分支").selectOption(mainline);
    await expect(page.locator(".chat-message")).toHaveCount(3);
    await expect(page.getByText("分支结果已合并", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "mobile-conversation.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("tab", { name: "上下文 DAG" }).click();
    await page.locator(".dag-node.input").first().click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(screenshots, "mobile-dag.png"), fullPage: true });
    await page.getByRole("link", { name: "系统状态", exact: true }).click();
    await expect(page.getByRole("heading", { name: "频道连接" })).toBeVisible();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
