import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { RuntimeAdminClient } from "../packages/runtime-client/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("工作台主线不请求分支任务，切换分支后查询对应任务", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-workspace-tasks-"));
  const server = new RuntimeServer({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, token: "tasks-browser-test" }
    }),
    logger: { info() {}, warn() {}, error() {} }
  });
  let browser;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "tasks-browser-test" });
    const { session } = await client.createSession("任务查询回归", "session");
    const { run } = await client.submitRun({ sessionId: session.id, text: "主线运行", idempotencyKey: "main" });
    await expect.poll(async () => (await client.run(run.id)).run.status).toBe("succeeded");
    const graph = await client.sessionGraph(session.id);
    const { branch } = await client.forkSession(session.id, {
      commitId: graph.refs.find((ref) => ref.name === `line:${session.mainlineId}`).commitId,
      title: "任务分支",
      idempotencyKey: "fork"
    });
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage();
    const taskRequests = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/admin/tasks") taskRequests.push(request.url());
    });
    await page.goto(`${endpoint}/#/workspace?session=${encodeURIComponent(session.id)}`);
    await page.getByLabel("访问令牌").fill("tasks-browser-test");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    await expect(page.getByRole("heading", { name: "任务查询回归", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(page.getByText("暂无分支任务", { exact: true })).toBeVisible();
    await expect(page.locator(".workspace-run")).toHaveCount(1);
    assert.deepEqual(taskRequests, []);
    await page.getByLabel("当前分支").selectOption(branch.id);
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/admin/tasks" && url.searchParams.get("branchId") === branch.id;
    });
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await expect(page.getByText("暂无分支任务", { exact: true })).toBeVisible();
    await page.getByLabel("当前分支").selectOption(session.mainlineId);
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(page.getByText("暂无分支任务", { exact: true })).toBeVisible();
    await expect(page.locator(".workspace-run")).toHaveCount(1);
    assert.ok(taskRequests.length > 0);
    assert.ok(taskRequests.every((url) => new URL(url).searchParams.get("branchId") === branch.id));
    await expect(page.getByText("运行时发生内部错误，请稍后重试。", { exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
