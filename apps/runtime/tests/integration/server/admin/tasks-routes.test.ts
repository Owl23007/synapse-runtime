import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { parseConfigObject } from "../../../../src/config/index.js";
import { RuntimeServer } from "../../../../src/server/runtime-server.js";

describe("分支任务查询", () => {
  it("拒绝主线和不存在的分支，保留分支过滤、未完成任务查询与认证边界", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-task-api-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const store = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    onTestFinished(() => store.close());
    const server = new RuntimeServer({
      config: parseConfigObject({
        runtime: { dataDir: directory },
        server: { host: "127.0.0.1", port: 0 },
        admin: { host: "127.0.0.1", port: 0, token: "tasks-test-token" }
      }),
      logger: { info() {}, warn() {}, error() {} }
    });
    try {
      const session = await store.createSession({ id: "native:tasks" });
      const source = await store.appendEvent(session.mainlineId, {
        type: "user_message",
        payload: { text: "创建任务分支" },
        idempotencyKey: "source"
      });
      const branch = await store.createBranch({
        sessionId: session.id,
        sourceEventId: source.id,
        title: "任务分支",
        goal: "验证任务过滤",
        reason: "隔离主线与分支",
        createdBy: "user",
        idempotencyKey: "branch"
      });
      await store.transitionBranch(branch.id, { status: "active", idempotencyKey: "active" });
      const task = await store.createTask(branch.id, {
        executor: "test-executor",
        input: {},
        idempotencyKey: "task"
      });
      await store.transitionTask(task.id, { status: "running", idempotencyKey: "running" });
      await store.transitionTask(task.id, { status: "completed", idempotencyKey: "completed" });

      const listening = await server.start();
      const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
      const client = new RuntimeAdminClient({ endpoint, token: "tasks-test-token" });
      expect(await client.tasks(branch.id)).toMatchObject({
        ok: true,
        tasks: [{ id: task.id, branchId: branch.id, status: "completed" }]
      });
      expect(await client.tasks()).toEqual({ ok: true, tasks: [] });
      const headers = { authorization: "Bearer tasks-test-token" };
      await Promise.all(
        [session.mainlineId, "missing", "", " "].map(async (branchId) => {
          const response = await fetch(`${endpoint}/admin/tasks?branchId=${encodeURIComponent(branchId)}`, { headers });
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({
            ok: false,
            error: "branch_not_found",
            message: "未找到对应的分支。"
          });
        })
      );
      expect((await fetch(`${endpoint}/admin/tasks?branchId=${encodeURIComponent(branch.id)}`)).status).toBe(401);
    } finally {
      await server.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
