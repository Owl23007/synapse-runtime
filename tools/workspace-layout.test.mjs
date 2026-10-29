import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { RuntimeAdminClient } from "../packages/runtime-client/dist/index.js";
import { SqliteRuntimeContextStore } from "../packages/runtime-core/dist/index.js";
import { ArtifactStore } from "../packages/tool-container/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("工作台分栏、历史滚动分页、工具回执与会话切换使用真实 Admin", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-workspace-layout-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/workspace-layout");
  await mkdir(screenshots, { recursive: true });
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "layout-test-only" }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  let seed;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "layout-test-only" });
    await Promise.all(
      Array.from({ length: 64 }, (_, index) => client.createSession(`历史会话 ${index}`, `history-${index}`))
    );
    const { session } = await client.createSession("项目架构分析", "layout-session");
    const { run: executed } = await client.submitRun({
      sessionId: session.id,
      lineId: session.mainlineId,
      text: "分析项目结构与核心工作流",
      idempotencyKey: "layout-message"
    });
    await expect.poll(async () => (await client.run(executed.id)).run.status).toBe("succeeded");
    // 种入足够多的持久事实覆盖真实分页；页面、SSE、认证和下载仍使用生产装配
    seed = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    const run = seed.runs.accept({
      sessionId: session.id,
      lineId: session.mainlineId,
      channelId: "native",
      sourceEventId: "layout-run",
      summary: "分析项目模块依赖"
    });
    seed.runs.append(run.id, { key: "start", type: "run_started", status: "running", phase: "tool" });
    for (let index = 0; index < 205; index++)
      seed.runs.append(run.id, { key: `permission-${index}`, type: "permission_allowed" });
    seed.runs.append(run.id, {
      key: "read-start",
      type: "tool_call_started",
      data: { callId: "read", name: "read_file", input: { path: "src/main.ts" } }
    });
    seed.runs.append(run.id, {
      key: "read-end",
      type: "tool_call_succeeded",
      durationMs: 12,
      data: { callId: "read", name: "read_file", output: { text: "应用入口" } }
    });
    seed.runs.append(run.id, {
      key: "search-start",
      type: "tool_call_started",
      data: { callId: "search", name: "code_search", input: { pattern: "import" } }
    });
    seed.runs.append(run.id, {
      key: "search-end",
      type: "tool_call_succeeded",
      durationMs: 16,
      data: { callId: "search", name: "code_search", output: { matches: 8 } }
    });
    seed.runs.append(run.id, {
      key: "graph-start",
      type: "tool_call_started",
      data: { callId: "graph", name: "analyze_dependencies", input: { path: "src/" } }
    });
    const graphStore = seed.contextGraph;
    for (let index = 0; index < 205; index++)
      graphStore.commit({
        scopeId: session.id,
        refName: `line:${session.mainlineId}`,
        expectedVersion: graphStore.getRef(session.id, `line:${session.mainlineId}`).version,
        idempotencyKey: `history-node-${index}`,
        type: "output",
        content: { text: `分析记录 ${index}` }
      });
    const { branch } = await client.forkSession(session.id, {
      commitId: graphStore.getRef(session.id, `line:${session.mainlineId}`).commitId,
      title: "体验验证",
      idempotencyKey: "layout-branch"
    });
    await seed.createTask(branch.id, {
      executor: "architecture-review",
      input: { scope: "core" },
      idempotencyKey: "layout-task"
    });
    const artifacts = new ArtifactStore(join(directory, "artifacts"), config.container);
    artifacts.save({ sessionId: session.id, runId: run.id, callId: "report" }, [
      { name: "architecture.md", data: Buffer.from("# 项目模块\nWebUI / Runtime / Tools") },
      { name: "dependencies.json", data: Buffer.from('{"modules":3}') }
    ]);
    seed.close();
    seed = undefined;
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1584, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${endpoint}/#/workspace?session=${encodeURIComponent(session.id)}`);
    await page.getByLabel("访问令牌").fill("layout-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("heading", { name: "项目架构分析", exact: true })).toBeVisible();
    await expect(page.locator(".tool-activity")).toHaveCount(3);
    await expect(page.locator(".tool-activity").first().getByText("read_file", { exact: true })).toBeVisible();
    await expect(page.locator(".related-artifact")).toHaveCount(2);
    await expect(page.locator(".tool-status.succeeded")).toHaveCount(2);
    await expect(page.locator(".tool-status.running")).toHaveCount(1);
    const settings = await page.getByRole("link", { name: "系统状态", exact: true }).boundingBox();
    assert.ok(settings.y > 700);
    await page.screenshot({ path: join(screenshots, "workspace.png"), fullPage: true });
    assert.equal(await page.getByRole("button", { name: "加载更多会话" }).count(), 0);
    await expect(page.locator(".session-row")).toHaveCount(50);
    await page.getByLabel("会话列表", { exact: true }).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.locator(".session-row")).toHaveCount(65);
    await expect(page.locator(".context-history-row")).toHaveCount(200);
    await page.getByLabel("提交历史", { exact: true }).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(async () => page.locator(".context-history-row").count()).toBeGreaterThan(200);
    await page.locator(".context-history-row").last().click();
    await expect(page.locator(".node-inspector")).toBeVisible();
    const historyCount = await page.locator(".context-history-row").count();
    await expect.poll(async () => page.locator(".context-history-row").count()).toBeGreaterThanOrEqual(historyCount);
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "收起运行面板" }).click();
    await expect(page.getByLabel("运行面板", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "收起导航" }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "72px");
    await page.getByRole("button", { name: "展开导航" }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "224px");
    await page.getByRole("button", { name: "收起会话列表" }).click();
    await expect(page.getByLabel("会话与上下文", { exact: true })).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("搜索会话")).toBeFocused();
    await page.getByLabel("搜索会话").fill("历史会话 0");
    await page.locator(".session-row").click();
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "展开运行面板" })).toBeVisible();
    await page.getByLabel("搜索会话").fill("项目架构分析");
    await page.locator(".session-row").click();
    await expect(page.getByRole("button", { name: "展开运行面板" })).toBeVisible();
    await page.getByRole("button", { name: "展开运行面板" }).click();
    await expect(page.locator(".tool-activity")).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    await expect(page.locator(".session-pane")).toBeHidden();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "展开运行面板" }).click();
    await expect(page.getByRole("button", { name: "关闭运行面板" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "展开运行面板" })).toBeFocused();
    await page.screenshot({ path: join(screenshots, "mobile-inspector-closed.png"), fullPage: true });
    await page.setViewportSize({ width: 1584, height: 1000 });
    await page.getByLabel("当前分支").selectOption(branch.id);
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(page.locator(".workspace-task")).toHaveCount(1);
    await page.locator(".workspace-task > summary").click();
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await expect(page.locator(".task-state")).toHaveText("已取消");
    await page.getByLabel("当前分支").selectOption(session.mainlineId);
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(page.locator(".workspace-task")).toHaveCount(0);
    await page.getByRole("link", { name: "频道", exact: true }).click();
    await expect(page.getByRole("heading", { name: "频道连接", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "任务", exact: true }).click();
    await expect(page.getByRole("heading", { name: "活动任务", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "频道连接", exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    seed?.close();
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
