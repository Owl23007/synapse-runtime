import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { SqliteRuntimeContextStore } from "../packages/runtime-core/dist/index.js";
import { ArtifactStore } from "../packages/tool-container/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("WebUI 通过真实 Admin 检查持久运行、上下文、DAG 和工件，并在刷新后清除凭据", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-browser-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/webui");
  await mkdir(screenshots, { recursive: true });
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "browser-test-only" }
  });
  // 仅种入测试事实，HTTP、认证、数据库、SSE 与下载均使用生产装配
  const seed = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
  await seed.ensureSession({ sessionId: "session-browser" });
  const root = seed.contextGraph.commit({
    scopeId: "session-browser",
    refName: "main",
    expectedVersion: null,
    idempotencyKey: "initial",
    type: "input",
    content: { text: "项目报告输入" }
  });
  seed.contextGraph.commit({
    scopeId: "session-browser",
    refName: "main",
    expectedVersion: 1,
    idempotencyKey: "output",
    type: "output",
    content: { text: "项目报告完成" }
  });
  const run = seed.runs.accept({
    sessionId: "session-browser",
    channelId: "qq-report",
    sourceEventId: "browser-source",
    summary: "生成项目进展报告"
  });
  seed.runs.append(run.id, { key: "started", type: "run_started", status: "running" });
  seed.runs.append(run.id, {
    key: "context",
    type: "context_resolved",
    data: { ref: "main", commitIds: [root.id], input: "<img src=x onerror=alert(1)>" }
  });
  seed.runs.append(run.id, {
    key: "model",
    type: "model_call_succeeded",
    durationMs: 128,
    data: { model: "test-provider", output: "报告已生成", usage: null }
  });
  seed.runs.append(run.id, { key: "sent", type: "response_sent", data: { messageId: "platform-confirmed" } });
  seed.runs.append(run.id, { key: "finished", type: "run_succeeded", status: "succeeded" });
  const artifacts = new ArtifactStore(join(directory, "artifacts"), config.container);
  artifacts.save({ sessionId: "session-browser", runId: run.id, callId: "report-call" }, [
    { name: "report.csv", data: Buffer.from("name,value\nSynapse,42") }
  ]);
  seed.close();
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  let liveStore;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(endpoint);
    await expect(page.getByRole("heading", { name: "连接 Runtime" })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "connect.png"), fullPage: true });
    await page.getByLabel("访问令牌").fill("wrong");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("alert")).toContainText("401");
    await page.getByLabel("访问令牌").fill("browser-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
    await expect(page.getByText("实时连接", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "生成项目进展报告", exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "overview.png"), fullPage: true });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.getByRole("link", { name: "生成项目进展报告", exact: true }).click();
    await expect(page.getByRole("button", { name: /模型返回/ })).toBeVisible();
    await page.getByRole("button", { name: /模型返回/ }).click();
    await expect(page.locator(".event-detail")).toContainText("test-provider");
    await page.screenshot({ path: join(screenshots, "run-detail.png"), fullPage: true });
    await page.getByRole("tab", { name: "上下文快照" }).click();
    await expect(page.locator(".json")).toContainText("<img src=x onerror=alert(1)>");
    assert.equal(await page.locator("main img").count(), 0);
    await page.getByRole("link", { name: "session-browser" }).click();
    await expect(page.getByRole("heading", { name: "数据浏览", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^main/ }).click();
    await page.getByRole("button", { name: "查看引用头提交" }).click();
    await expect(page.getByRole("button", { name: /父提交/ })).toBeVisible();
    await page.getByRole("button", { name: /父提交/ }).click();
    await expect(page.getByText("根提交 · 没有父节点")).toBeVisible();
    await page.getByRole("tab", { name: "工件", exact: true }).click();
    await page.getByRole("button", { name: /report.csv/ }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载工件" }).click();
    const download = await downloadPromise;
    assert.equal(await readFile(await download.path(), "utf8"), "name,value\nSynapse,42");
    await page.screenshot({ path: join(screenshots, "explorer.png"), fullPage: true });
    await page.getByRole("link", { name: "运行记录", exact: true }).click();
    liveStore = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    liveStore.runs.accept({
      sessionId: "session-browser",
      channelId: "qq-report",
      sourceEventId: "live-update",
      summary: "浏览器在线时的新请求"
    });
    await expect(page.getByRole("link", { name: "浏览器在线时的新请求", exact: true })).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByText("正在重连", { exact: true })).toBeVisible({ timeout: 20000 });
    liveStore.runs.accept({
      sessionId: "session-browser",
      channelId: "qq-report",
      sourceEventId: "offline-update",
      summary: "断线期间的新请求"
    });
    await page.context().setOffline(false);
    await expect(page.getByRole("link", { name: "断线期间的新请求", exact: true })).toBeVisible();
    await page.getByLabel("状态", { exact: true }).selectOption("failed");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page.getByText("暂无运行记录", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.reload();
    await expect(page.getByRole("heading", { name: "连接 Runtime" })).toBeVisible();
    assert.equal(await page.getByLabel("访问令牌").inputValue(), "");
    await page.getByLabel("访问令牌").fill("browser-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByLabel("状态", { exact: true })).toHaveValue("failed");
    assert.deepEqual(errors, []);
    console.log(`WebUI screenshots: ${screenshots}`);
  } finally {
    liveStore?.close();
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
