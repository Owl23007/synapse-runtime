import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { parseConfigObject } from "../../../../src/config/index.js";
import { RuntimeServer } from "../../../../src/server/runtime-server.js";

describe("持久目标管理契约", () => {
  it("无需分支按工作区查询目标，取消检查 revision，并保持认证边界", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-task-api-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const store = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    await store.bindProjectWorkspace({ workspaceId: "project", identityId: "owner" });
    const grant = store.execution.issueGrant({
      key: "admin",
      workspaceId: "project",
      principalId: "owner",
      source: { platform: "cli", channelId: "background", conversationId: "project", conversationKind: "system" }
    });
    const task = store.execution.createTask(grant, {
      key: "goal",
      goal: "验证目标管理",
      acceptance: "正确处理修订和权限"
    });
    store.execution.controlTask(task.id, 1, "paused");
    store.close();
    const server = new RuntimeServer({
      config: parseConfigObject({
        runtime: { dataDir: directory },
        server: { host: "127.0.0.1", port: 0 },
        admin: { host: "127.0.0.1", port: 0, token: "tasks-test-token" }
      }),
      logger: { info() {}, warn() {}, error() {} }
    });
    onTestFinished(() => server.stop());
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
    const client = new RuntimeAdminClient({ endpoint, token: "tasks-test-token" });
    expect(await client.tasks("project")).toMatchObject({
      ok: true,
      tasks: [{ id: task.id, workspaceId: "project", goal: "验证目标管理", revision: 2, status: "paused" }]
    });
    expect(await client.tasks("other")).toEqual({ ok: true, tasks: [] });
    expect(await client.task(task.id)).toMatchObject({ task: { id: task.id, status: "paused" } });
    await expect(client.cancelTask(task.id, 1)).rejects.toThrow("409");
    expect(await client.cancelTask(task.id, 2)).toMatchObject({
      task: { id: task.id, revision: 3, status: "cancelled" }
    });
    await expect(client.cancelTask(task.id, 3)).rejects.toThrow("409");
    await expect(client.task("missing")).rejects.toThrow("404");
    const headers = { authorization: "Bearer tasks-test-token" };
    expect((await fetch(`${endpoint}/admin/tasks?branchId=obsolete`, { headers })).status).toBe(409);
    expect((await fetch(`${endpoint}/admin/tasks`)).status).toBe(401);
    await server.stop();
  });
});
