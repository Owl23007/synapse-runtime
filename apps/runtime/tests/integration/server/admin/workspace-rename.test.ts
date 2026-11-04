import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createAdminServerFixture } from "../../../helpers/admin-server.js";
import { parseConfigObject } from "../../../../src/config/index.js";

it("会话标题改名持久化且保留会话身份、创建重放和历史上下文", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synapse-rename-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "rename-test" }
  });
  const { client, endpoint, server } = await createAdminServerFixture(config);
  const { session } = await client.createSession("原始标题", "create-title");
  const graph = await client.sessionGraph(session.id);
  expect((await client.renameSession(session.id, "  更新后的标题  ")).session).toMatchObject({
    id: session.id,
    mainlineId: session.mainlineId,
    metadata: { title: "更新后的标题" }
  });
  expect((await client.sessions()).items[0]?.title).toBe("更新后的标题");
  expect((await client.sessionGraph(session.id)).nodes).toEqual(graph.nodes);
  expect((await client.createSession("原始标题", "create-title")).session.metadata?.title).toBe("更新后的标题");
  await expect(client.createSession("其他请求", "create-title")).rejects.toThrow("409");
  await Promise.all(
    ["", " ", "长".repeat(121)].map((title) => expect(client.renameSession(session.id, title)).rejects.toThrow("400"))
  );
  await expect(client.renameSession("missing", "标题")).rejects.toThrow("404");
  expect(
    (
      await fetch(`${endpoint}/admin/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "未授权" })
      })
    ).status
  ).toBe(401);
  await server.stop();
  const restarted = await createAdminServerFixture(config);
  expect((await restarted.client.workspace(session.id)).session.metadata?.title).toBe("更新后的标题");
});
