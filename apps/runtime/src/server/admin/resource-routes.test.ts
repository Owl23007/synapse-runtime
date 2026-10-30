import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { RuntimeServer } from "../runtime-server.js";
import { parseConfigObject } from "../../config/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synapse-resource-http-"));
  const shared = join(root, "shared");
  mkdirSync(shared);
  writeFileSync(join(shared, "data.txt"), "mount one");
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRuntimeContextStore({ databasePath: join(root, "runtime-context.sqlite") });
  for (const id of ["a", "b"])
    await store.resolveWorkspace({
      platform: "qq",
      provider: "napcat",
      channelId: "qq",
      conversationType: "group",
      conversationId: id,
      identityId: "actor",
      defaultWorkspace: { id, type: "group", name: id }
    });
  store.close();
  const config = parseConfigObject({
    runtime: { dataDir: root },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "resource-token" },
    capabilities: { autoCheckUpdates: false, skillsDirectory: join(root, "skills") },
    files: { mounts: [{ id: "shared", root: shared, urlPrefix: "/files/shared" }] }
  });
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  const listening = await server.start();
  cleanup.push(() => server.stop());
  const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
  const client = new RuntimeAdminClient({ endpoint, token: "resource-token" });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(endpoint + path, { ...init, headers: { authorization: "Bearer resource-token", ...init.headers } });
  const session = async (workspaceId: string) => {
    const response = await request("/admin/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: workspaceId, idempotencyKey: workspaceId, workspaceId })
    });
    expect(response.status).toBe(200);
    return (await response.json()).session as { id: string; mainlineId: string };
  };
  return { root, shared, server, endpoint, client, request, session };
}
describe("resource HTTP lifecycle", () => {
  it("uploads, previews, pins run attachments, preserves old content on replace, and keeps workspace boundaries", async () => {
    const { client, request, session, endpoint } = await fixture();
    const a = await session("a");
    const b = await session("b");
    expect((await fetch(endpoint + "/admin/workspaces")).status).toBe(401);
    const file = new File(["version one"], "报告.txt", { type: "text/plain" });
    const first = await client.uploadAsset("a", file, "upload-one");
    expect((await client.uploadAsset("a", file, "upload-one")).version.id).toBe(first.version.id);
    await expect(
      client.uploadAsset("a", new File(["version two"], "报告.txt", { type: "text/plain" }), "upload-one")
    ).rejects.toThrow("409");
    expect((await client.assets("b")).items).toEqual([]);
    expect((await request(`/admin/assets/${first.asset.id}/content?workspaceId=b`)).status).toBe(404);
    const response = await request(`/admin/assets/${first.asset.id}/content`, { headers: { range: "bytes=0-6" } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("version");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expect(
      client.submitRun({
        sessionId: b.id,
        lineId: b.mainlineId,
        text: "read",
        idempotencyKey: "cross",
        attachments: [{ assetId: first.asset.id, versionId: first.version.id }]
      })
    ).rejects.toThrow("404");
    const run = await client.submitRun({
      sessionId: a.id,
      lineId: a.mainlineId,
      text: "read attachment",
      idempotencyKey: "run-one",
      attachments: [{ assetId: first.asset.id, versionId: first.version.id }]
    });
    await expect.poll(async () => (await client.run(run.run.id)).run.status).toBe("succeeded");
    const dependencies = (await client.runDependencies(run.run.id)) as {
      snapshot: { workspaceId: string; assets: unknown[] };
    };
    expect(dependencies.snapshot.workspaceId).toBe("a");
    expect(dependencies.snapshot.assets).toEqual([
      { assetId: first.asset.id, versionId: first.version.id, sha256: first.version.sha256 }
    ]);
    const second = await client.uploadAsset(
      "a",
      new File(["version two"], "报告.txt", { type: "text/plain" }),
      "upload-two",
      first.asset.id
    );
    expect(second.version.versionNo).toBe(2);
    await client.deleteAsset(first.asset.id);
    expect((await client.assets("a")).items).toEqual([]);
    expect(await (await client.downloadAsset(first.asset.id, first.version.id)).text()).toBe("version one");
    expect((await client.asset(first.asset.id)).refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ refType: "run", refId: run.run.id, versionId: first.version.id })
      ])
    );
  });
  it("serves readonly mount URLs and materializes changing files without rewriting history", async () => {
    const { client, request, shared, endpoint } = await fixture();
    expect((await fetch(endpoint + "/files/shared?path=data.txt")).status).toBe(401);
    expect(await (await request("/files/shared?path=data.txt")).text()).toBe("mount one");
    expect((await request("/files/shared?path=../private")).status).toBe(403);
    expect((await request("/files/shared", { method: "DELETE" })).status).toBe(405);
    const first = await client.materializeMount("a", "shared", "data.txt");
    writeFileSync(join(shared, "data.txt"), "mount two");
    const second = await client.materializeMount("a", "shared", "data.txt");
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.version.id).not.toBe(first.version.id);
    expect(await (await client.downloadAsset(first.asset.id, first.version.id)).text()).toBe("mount one");
    expect(await (await request("/files/shared?path=data.txt")).text()).toBe("mount two");
    expect(JSON.stringify(await client.mounts("a"))).not.toContain(shared);
  });
});
