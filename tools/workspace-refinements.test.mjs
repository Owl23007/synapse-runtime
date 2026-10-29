import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { RuntimeServer } from "../apps/runtime/dist/index.js";
import { parseConfigObject } from "../apps/runtime/dist/config/index.js";
import { SqliteRuntimeContextStore } from "../packages/runtime-core/dist/index.js";

const requireWebUi = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { chromium, expect } = requireWebUi("@playwright/test");

test("工作台标注修正兼容旧列表，展示频道、最新日期与原生初始化摘要", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "synapse-workspace-refinements-"));
  const screenshots = resolve(import.meta.dirname, "../test-results/workspace-refinements");
  await mkdir(screenshots, { recursive: true });
  const seed = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
  const session = await seed.createSession({
    id: "qq:napcat:qq-local:group:807754424",
    locator: {
      platform: "qq",
      provider: "napcat",
      channelId: "qq-local",
      conversationType: "group",
      conversationId: "807754424"
    },
    metadata: { conversationTitle: "硬件设计讨论" },
    createdAt: "2026-07-05T00:00:00Z"
  });
  await seed.appendEvent(session.mainlineId, {
    type: "user_message",
    payload: { text: "检查设计约束" },
    idempotencyKey: "user",
    createdAt: "2026-10-27T06:32:00Z"
  });
  await seed.appendEvent(session.mainlineId, {
    type: "assistant_message",
    payload: { text: "设计约束已整理" },
    idempotencyKey: "reply",
    createdAt: "2026-10-27T06:35:00Z"
  });
  seed.close();
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "refinement-test-only" }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  let browser;
  try {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin.port}`;
    const channel = process.env.SYNAPSE_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chromium");
    browser = await chromium.launch({ headless: true, ...(channel === "chromium" ? {} : { channel }) });
    const page = await browser.newPage({ viewport: { width: 1584, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 仅移除新增展示字段以模拟仍在使用的旧 Runtime，所有会话正文仍从真实接口补读
    await page.route("**/admin/sessions", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.items = body.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(
            ([key]) =>
              !["lastMessageAt", "platform", "provider", "conversationId", "conversationTitle", "updatedAt"].includes(
                key
              )
          )
        )
      );
      return route.fulfill({ response, json: body });
    });
    await page.goto(`${endpoint}/#/workspace`);
    await page.getByLabel("访问令牌").fill("refinement-test-only");
    await page.getByRole("button", { name: "连接工作空间" }).click();
    const row = page.locator(".session-row").filter({ hasText: "硬件设计讨论" });
    await expect(row).toBeVisible();
    await expect(row.locator("time")).toHaveAttribute("datetime", "2026-10-27T06:35:00Z");
    await expect(row).toContainText("NapCat");
    await expect(page.locator(".session-pane .create-session")).toHaveCount(0);
    assert.ok((await page.getByRole("button", { name: "收起导航" }).boundingBox()).y < 100);
    await row.click();
    await expect(page.getByRole("heading", { name: "硬件设计讨论", exact: true })).toBeVisible();
    await expect(page.locator(".message-meta time").last()).toHaveText(/\d{1,2}:\d{2}/);
    await expect(page.locator(".session-pane-toggle")).toHaveCSS("border-radius", "50%");
    await expect(page.locator(".inspector-close")).toHaveCount(0);
    await expect(page.locator(".workspace-header-actions").getByRole("button", { name: "收起运行面板" })).toHaveCount(
      0
    );
    await expect(page.locator(".workspace-inspector").getByRole("button", { name: "收起运行面板" })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "channel.png"), fullPage: true });
    await page.locator(".workspace-inspector").getByRole("button", { name: "收起运行面板" }).click();
    await expect(page.getByRole("button", { name: "展开运行面板" })).toBeVisible();
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    await page.getByLabel("初始消息", { exact: true }).fill("分析项目依赖关系并整理核心模块");
    await page.getByRole("button", { name: "开始会话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分析项目依赖关系并整理核心模块", exact: true })).toBeVisible();
    await expect(page.locator(".chat-message")).toHaveCount(2);
    await page.getByRole("button", { name: "频道", exact: true }).click();
    await expect(page.locator(".session-row")).toHaveCount(1);
    await expect(page.locator(".session-row")).toContainText("硬件设计讨论");
    await page.getByRole("button", { name: "原生", exact: true }).click();
    await expect(page.locator(".session-row")).toHaveCount(1);
    await expect(page.locator(".session-row")).toContainText("原生会话");
    await page.screenshot({ path: join(screenshots, "native.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("button", { name: "展开运行面板" }).click();
    await expect(page.getByRole("button", { name: "关闭运行面板" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "展开运行面板" })).toBeFocused();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
