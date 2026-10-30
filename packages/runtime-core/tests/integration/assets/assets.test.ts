import { createWorkspaceStoreFixture } from "../../helpers/workspace.js";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { AssetBlobStore } from "../../../src/assets/blob-store.js";
import { AssetService } from "../../../src/assets/service.js";

async function createAssetsFixture() {
  const { root, store } = await createWorkspaceStoreFixture("synapse-assets-");
  const blobs = new AssetBlobStore(join(root, "assets"), 1024);
  const service = new AssetService(store.assets, blobs, {
    maxNativeUploadBytes: 100,
    maxRemoteFetchBytes: 100,
    maxConcurrentFetches: 2
  });
  return { store, service, root };
}
function observe(store: SqliteRuntimeContextStore) {
  return store.assets.observe({
    workspaceId: "a",
    name: "报告.txt",
    kind: "qq_group",
    locator: { channelId: "qq", groupId: "1", fileId: "stable" }
  });
}
async function upload(service: AssetService, text: string, key: string, assetId?: string) {
  const bytes = Buffer.from(text);
  const init = service.beginUpload("a", {
    name: "报告.txt",
    size: bytes.length,
    idempotencyKey: key,
    ...(assetId ? { assetId } : {})
  });
  return service.upload(init.uploadId, bytes);
}
describe("工作区文件资源", () => {
  it("索引重复远程通知且不创建内容版本或运行", async () => {
    const { store } = await createAssetsFixture();
    const first = observe(store);
    const repeated = observe(store);
    expect(first.id).toBe(repeated.id);
    expect(first.currentVersionId).toBeNull();
    expect(store.assets.sources("a", first.id)).toHaveLength(1);
    expect(store.runs.list({}).items).toHaveLength(0);
    expect(store.assets.db.prepare("SELECT COUNT(*) AS count FROM asset_versions").get()).toEqual({ count: 0 });
  });
  it("重新打开后保留索引与迁移历史", async () => {
    const { store, root } = await createAssetsFixture();
    const asset = observe(store);
    store.close();
    const reopened = new SqliteRuntimeContextStore({ databasePath: join(root, "runtime.sqlite") });
    onTestFinished(() => reopened.close());
    expect(observe(reopened).id).toBe(asset.id);
    expect(reopened.assets.db.pragma("foreign_key_check")).toEqual([]);
    expect(
      reopened.assets.db.prepare("SELECT COUNT(*) AS count FROM resource_migrations WHERE id = 'resources-v1'").get()
    ).toEqual({ count: 1 });
  });
  it("上传完成后才发布字节并在替换与删除后保留固定的旧版本", async () => {
    const { service, store } = await createAssetsFixture();
    const first = await upload(service, "v1", "one");
    const scope = { workspaceId: "a", runId: "run" };
    expect((await service.read(scope, first.asset.id)).bytes.toString()).toBe("v1");
    const second = await upload(service, "v2", "two", first.asset.id);
    expect(second.version.versionNo).toBe(2);
    expect((await service.read(scope, first.asset.id)).version.id).toBe(first.version.id);
    store.assets.remove("a", first.asset.id);
    expect(store.assets.list("a").items).toHaveLength(0);
    expect((await service.read(scope, first.asset.id)).bytes.toString()).toBe("v1");
    await expect(service.read({ workspaceId: "b", runId: "run" }, first.asset.id)).rejects.toMatchObject({
      status: 404
    });
    await expect(service.read({ workspaceId: "a" }, first.asset.id)).rejects.toMatchObject({ status: 404 });
  });
  it("拒绝上传参数与内容冲突且不发布新版本", async () => {
    const { service, store } = await createAssetsFixture();
    const first = await upload(service, "v1", "one");
    expect(() => service.beginUpload("a", { name: "other", size: 2, idempotencyKey: "one" })).toThrow(
      "upload_idempotency_conflict"
    );
    const again = service.beginUpload("a", { name: "报告.txt", size: 2, idempotencyKey: "one" });
    await expect(service.upload(again.uploadId, Buffer.from("v2"))).rejects.toThrow("upload_content_conflict");
    expect(store.assets.get("a", first.asset.id).currentVersionId).toBe(first.version.id);
    expect((await service.upload(again.uploadId, Buffer.from("v1"))).version.id).toBe(first.version.id);
  });
  it("在 SQLite 层拒绝跨工作区来源、错误版本头与无版本运行引用", async () => {
    const { service, store } = await createAssetsFixture();
    const first = await upload(service, "v1", "one");
    const other = observe(store);
    const db = store.assets.db;
    expect(() =>
      db.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(first.version.id, other.id)
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO asset_sources VALUES ('bad', 'b', ?, 'native', 'bad', '{}', 'now', 'now')")
        .run(first.asset.id)
    ).toThrow();
    expect(() =>
      store.assets.reference({
        workspaceId: "a",
        assetId: first.asset.id,
        versionId: null,
        refType: "run",
        refId: "run"
      })
    ).toThrow("version_required");
    expect(() => db.prepare("UPDATE asset_versions SET size_bytes = 0 WHERE id = ?").run(first.version.id)).toThrow(
      "immutable"
    );
    expect(() => db.prepare("DELETE FROM asset_versions WHERE id = ?").run(first.version.id)).toThrow();
  });
  it("去重非内容引用并将分页限制在工作区内", async () => {
    const { store } = await createAssetsFixture();
    const asset = observe(store);
    const ref = { workspaceId: "a", assetId: asset.id, versionId: null, refType: "message" as const, refId: "notice" };
    expect(store.assets.reference(ref).id).toBe(store.assets.reference(ref).id);
    store.assets.observe({ workspaceId: "a", name: "second", kind: "native", locator: { uploadId: "2" } });
    const page = store.assets.list("a", { limit: 1 });
    const next = store.assets.list("a", { limit: 1, cursor: page.nextCursor! });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect(next.nextCursor).toBeUndefined();
    expect(store.assets.list("b").items).toEqual([]);
  });
  it("远程内容不可用或上传中断时不创建版本", async () => {
    const { store, service } = await createAssetsFixture();
    const asset = observe(store);
    await expect(service.materialize("a", asset.id)).rejects.toThrow("asset_source_unsupported");
    expect(store.assets.get("a", asset.id)).toMatchObject({ currentVersionId: null, fetchState: "fetch-failed" });
    const init = service.beginUpload("a", { name: "partial", size: 3, idempotencyKey: "partial" });
    await expect(service.upload(init.uploadId, Buffer.from("a"))).rejects.toThrow("upload_size_mismatch");
    expect(store.assets.db.prepare("SELECT COUNT(*) AS count FROM asset_versions").get()).toEqual({ count: 0 });
  });
  it("关闭数据库前取消远程实体化并拒绝新写入", async () => {
    const { store, service } = await createAssetsFixture();
    const remote = new AssetService(store.assets, service.blobs, service.limits, async (_source, signal) => {
      return (async function* () {
        yield Buffer.from("partial");
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })();
    });
    const asset = observe(store);
    const fetching = remote.materialize("a", asset.id);
    const failed = fetching.catch((error: unknown) => error);
    await remote.drain();
    await expect(failed).resolves.toMatchObject({ message: "asset_fetch_failed" });
    await expect(remote.saveContent("a", asset.id, Buffer.from("new"))).rejects.toThrow("resource_service_closed");
    expect(store.assets.get("a", asset.id).currentVersionId).toBeNull();
  });
});
