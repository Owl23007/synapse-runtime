import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { SqliteRuntimeContextStore } from "../packages/runtime-core/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("运行分栏支持搜索、历史分页、回执归并、筛选直链与移动端检查", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-runs-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/runs");
  await mkdir(screenshots, { recursive: true });
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "runs-test-only" }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  let seed;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    seed = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    await seed.ensureSession({ sessionId: "runs-session" });
    for (let index = 0; index < 54; index++) {
      const run = seed.runs.accept({
        sessionId: "runs-session",
        channelId: "native",
        sourceEventId: `history-${index}`,
        summary: `历史任务 ${index}`
      });
      seed.runs.append(run.id, { key: "end", type: "run_succeeded", status: "succeeded" });
    }
    const selected = seed.runs.accept({
      sessionId: "runs-session",
      channelId: "native",
      sourceEventId: "analysis",
      summary: "项目架构分析"
    });
    seed.runs.append(selected.id, { key: "start", type: "run_started", status: "running" });
    seed.runs.append(selected.id, {
      key: "context",
      type: "context_resolved",
      data: { input: "<img src=x onerror=alert(1)>" }
    });
    seed.runs.append(selected.id, {
      key: "model",
      type: "model_call_succeeded",
      durationMs: 128,
      data: { model: "test-model" }
    });
    seed.runs.append(selected.id, {
      key: "tool-start",
      type: "tool_call_started",
      attemptId: "first",
      data: { callId: "read", name: "read_file" }
    });
    seed.runs.append(selected.id, {
      key: "tool-end",
      type: "tool_call_succeeded",
      attemptId: "first",
      durationMs: 24,
      data: { callId: "read", name: "read_file", output: "应用入口" }
    });
    seed.runs.append(selected.id, {
      key: "tool-pending",
      type: "tool_call_started",
      attemptId: "second",
      data: { callId: "read", name: "read_file" }
    });
    // 超过事件单页大小，验证归并后的工具列表可继续补读历史
    for (let index = 0; index < 205; index++)
      seed.runs.append(selected.id, { key: `permission-${index}`, type: "permission_allowed" });
    seed.runs.append(selected.id, { key: "delivery", type: "response_sent", data: { messageId: "confirmed" } });
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1585, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${endpoint}/#/runs`);
    await page.getByLabel("访问令牌").fill("runs-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.locator(".run-summary")).toHaveText("项目架构分析");
    await expect(page.locator(".run-tools-aside .run-tool")).toHaveCount(2);
    await page.locator(".run-tools-aside .run-tool").first().click();
    await expect(page.locator(".event-detail")).toContainText("应用入口");
    await expect(page.locator(".run-chart-bar")).toHaveCount(2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const content = await page.locator(".runs-page").boundingBox();
    const navigation = await page.locator(".sidebar").boundingBox();
    assert.ok(content.x >= navigation.x + navigation.width);
    await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("tab", { name: "交付记录" }).click();
    await expect(page.getByText("暂无交付事件", { exact: true })).toBeVisible();
    await expect(page.locator(".event-detail")).not.toContainText("应用入口");
    await page.getByRole("button", { name: "加载后续事件" }).click();
    await expect(page.locator(".timeline")).toContainText("回复已交付");
    await page.getByRole("tab", { name: "上下文快照" }).click();
    await expect(page.locator(".json")).toContainText("<img src=x onerror=alert(1)>");
    assert.equal(await page.locator("main img").count(), 0);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("历史任务 0");
    await expect(page.locator(".runs-row")).toHaveCount(0);
    await page.getByRole("button", { name: "加载更早记录" }).click();
    await expect(page.locator(".runs-row")).toHaveCount(1);
    await page.getByRole("searchbox").fill("");
    await page.locator(".runs-row").filter({ hasText: "项目架构分析" }).click();
    await expect(page.locator(".run-summary")).toHaveText("项目架构分析");
    seed.runs.accept({
      sessionId: "runs-session",
      channelId: "native",
      sourceEventId: "new-live",
      summary: "实时新增运行"
    });
    await expect(page.locator(".runs-row").filter({ hasText: "实时新增运行" })).toBeVisible();
    await expect(page.locator(".run-summary")).toHaveText("项目架构分析");
    await page.getByLabel("状态", { exact: true }).selectOption("failed");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page.getByText("暂无运行记录", { exact: true })).toBeVisible();
    assert.ok((await page.evaluate(() => location.hash)).includes("status=failed"));
    await page.goto(`${endpoint}/#/runs/${selected.id}`);
    await expect(page.getByRole("heading", { name: "项目架构分析", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "工具调用", exact: true }).click();
    await expect(page.locator(".run-tool")).toHaveCount(2);
    await page.goto(`${endpoint}/#/runs`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".run-summary")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
  } finally {
    seed?.close();
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
