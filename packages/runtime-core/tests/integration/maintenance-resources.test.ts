import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, onTestFinished } from "vitest";
import Database from "better-sqlite3";
import { SqliteRuntimeContextStore } from "../../src/storage/sqlite/runtime-context-store.js";
import { AssetService } from "../../src/assets/service.js";
import { AssetBlobStore } from "../../src/assets/blob-store.js";
import { CapabilityService } from "../../src/capabilities/service.js";
import {
  backupRuntimeData,
  verifyRuntimeBackup,
  restoreRuntimeData,
  type RuntimeBackupManifest
} from "../../src/maintenance.js";

const limits = { maxNativeUploadBytes: 1024, maxRemoteFetchBytes: 1024, maxConcurrentFetches: 2 };
const offline = async () => {
  throw new Error("不应访问网络");
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synapse-backup-resources-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const skillsDirectory = join(root, "skills");
  const store = new SqliteRuntimeContextStore({ databasePath: join(dataDir, "runtime-context.sqlite") });
  onTestFinished(() => store.close());
  await store.resolveWorkspace({
    platform: "qq",
    provider: "napcat",
    channelId: "qq",
    conversationType: "group",
    conversationId: "a",
    identityId: "actor",
    defaultWorkspace: { id: "a", type: "group", name: "a" }
  });
  const run = store.runs.accept({ sourceEventId: "event", sessionId: "session", channelId: "qq", summary: "历史附件" });
  const assets = new AssetService(store.assets, new AssetBlobStore(join(dataDir, "assets"), 4096), limits);
  const upload = assets.beginUpload("a", { name: "附件.txt", size: 7, idempotencyKey: "upload" });
  const uploaded = await assets.upload(upload.uploadId, Buffer.from("content"));
  await assets.read({ workspaceId: "a", runId: run.id }, uploaded.asset.id);
  const remote = store.assets.observe({
    workspaceId: "a",
    name: "尚未物化",
    kind: "qq_group",
    locator: { fileId: "remote" }
  });
  const external = join(root, "external");
  mkdirSync(join(external, "references"), { recursive: true });
  writeFileSync(join(external, "SKILL.md"), "---\nname: reports\ndescription: 报告\n---\n分析附件");
  writeFileSync(join(external, "references", "说明.txt"), "离线辅助资源");
  const caps = new CapabilityService(store.capabilities, skillsDirectory, [], offline, []);
  const skill = caps.registerDirectory(external, "runtime:reports", "admin");
  caps.bind("a", skill.packageKey, { installId: skill.id, enabled: true }, "admin");
  const dependencies = store.capabilities.pin(
    run.id,
    {
      workspaceId: "a",
      assets: [{ assetId: uploaded.asset.id, versionId: uploaded.version.id, sha256: uploaded.version.sha256 }],
      skills: [{ installId: skill.id, contentDigest: skill.contentDigest }],
      toolSetDigest: "tools",
      skillSetDigest: "skills",
      mcpConnections: []
    },
    [skill.id]
  );
  await assets.drain();
  store.close();
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  const restoredSkills = join(root, "restored-skills");
  const blobPath = `assets/blobs/${uploaded.version.sha256.slice(0, 2)}/${uploaded.version.sha256}`;
  const skillPath = join(skillsDirectory, "snapshots", skill.contentDigest);
  return {
    root,
    dataDir,
    skillsDirectory,
    backup,
    restored,
    restoredSkills,
    store,
    run,
    uploaded,
    remote,
    external,
    skill,
    dependencies,
    blobPath,
    skillPath
  };
}

function writeManifest(directory: string, manifest: RuntimeBackupManifest) {
  writeFileSync(join(directory, "backup-manifest.json"), JSON.stringify(manifest));
}

describe("持久资源完整备份", () => {
  it("导入后移除外部目录，跨根恢复后用原服务读取附件、Skill 与历史运行", async () => {
    const f = await fixture();
    expect(f.skill.installPath).toBeNull();
    rmSync(f.external, { recursive: true });
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    expect(manifest.version).toBe(2);
    expect(manifest.roots).toEqual(["data", "skills"]);
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ root: "data", path: f.blobPath }),
        expect.objectContaining({ root: "skills", path: `snapshots/${f.skill.contentDigest}/references/说明.txt` })
      ])
    );
    expect(JSON.stringify(manifest)).not.toContain(f.root);
    await verifyRuntimeBackup(f.backup);
    await restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills });
    // 原部署移除后读取，防止误用旧 install_path 让测试假成功
    rmSync(f.dataDir, { recursive: true });
    rmSync(f.skillsDirectory, { recursive: true });
    const reopened = new SqliteRuntimeContextStore({
      databasePath: join(f.restored, "runtime-context.sqlite"),
      exclusiveOwner: true
    });
    onTestFinished(() => reopened.close());
    const assets = new AssetService(reopened.assets, new AssetBlobStore(join(f.restored, "assets"), 4096), limits);
    onTestFinished(() => assets.drain());
    expect((await assets.read({ workspaceId: "a", runId: f.run.id }, f.uploaded.asset.id)).bytes.toString()).toBe(
      "content"
    );
    const caps = new CapabilityService(reopened.capabilities, f.restoredSkills, [], offline, []);
    expect(caps.enabled("a", f.run.id)[0]?.id).toBe(f.skill.id);
    expect(caps.loader(f.skill.id).readResource("references/说明.txt")).toMatchObject({ text: "离线辅助资源" });
    expect(reopened.capabilities.snapshot(f.run.id)).toEqual(f.dependencies);
    expect(reopened.runs.get(f.run.id)).toEqual(f.run);
    expect(reopened.assets.get("a", f.remote.id).currentVersionId).toBeNull();
  });

  it.each(["blob", "skill"])("缺少已物化 %s 时不提交备份", async (kind) => {
    const f = await fixture();
    rmSync(kind === "blob" ? join(f.dataDir, f.blobPath) : join(f.skillPath, "SKILL.md"));
    await expect(backupRuntimeData({ ...f, destination: f.backup })).rejects.toThrow();
    expect(existsSync(join(f.backup, "backup-manifest.json"))).toBe(false);
    expect(existsSync(join(f.backup, ".maintenance-incomplete"))).toBe(true);
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("未完成");
  });

  it.each(["blob", "skill"])("即使删除清单中的 %s 项，数据库引用验证仍失败", async (kind) => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    manifest.files = manifest.files.filter((file) =>
      kind === "blob" ? file.path !== f.blobPath : file.root !== "skills"
    );
    writeManifest(f.backup, manifest);
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("清单");
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow();
    expect(existsSync(join(f.restored, ".maintenance-incomplete"))).toBe(true);
    expect(existsSync(join(f.restoredSkills, ".maintenance-incomplete"))).toBe(true);
    expect(
      () =>
        new SqliteRuntimeContextStore({
          databasePath: join(f.restored, "runtime-context.sqlite"),
          exclusiveOwner: true
        })
    ).toThrow("未完成");
    expect(readFileSync(join(f.dataDir, f.blobPath), "utf8")).toBe("content");
  });

  it.each(["blob", "skill"])("重新计算文件摘要仍不能掩盖 %s 内容损坏", async (kind) => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    const file = manifest.files.find((file) =>
      kind === "blob" ? file.path === f.blobPath : file.path.endsWith("说明.txt")
    )!;
    const target = join(f.backup, ...(file.root === "skills" ? ["skills"] : []), file.path);
    writeFileSync(target, "changed");
    file.bytes = 7;
    file.sha256 = createHash("sha256").update("changed").digest("hex");
    writeManifest(f.backup, manifest);
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow(/引用内容校验失败|快照内容摘要/);
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow();
    expect(existsSync(join(f.restored, ".maintenance-incomplete"))).toBe(true);
  });

  it("旧绝对安装路径只在备份副本中规范化，并保留安装不可变约束", async () => {
    const f = await fixture();
    const db = new Database(join(f.dataDir, "runtime-context.sqlite"));
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'capability_snapshot_immutable'").get() as {
      sql: string;
    };
    db.exec("DROP TRIGGER capability_snapshot_immutable");
    db.prepare("UPDATE capability_installs SET install_path = ? WHERE id = ?").run(f.external, f.skill.id);
    db.exec(trigger.sql);
    db.close();
    await backupRuntimeData({ dataDir: f.dataDir, destination: f.backup });
    const source = new Database(join(f.dataDir, "runtime-context.sqlite"), { readonly: true });
    expect(source.prepare("SELECT install_path FROM capability_installs").get()).toEqual({ install_path: f.external });
    source.close();
    await restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills });
    const restored = new SqliteRuntimeContextStore({ databasePath: join(f.restored, "runtime-context.sqlite") });
    onTestFinished(() => restored.close());
    expect(restored.capabilities.get(f.skill.id).installPath).toBeNull();
    expect(() => restored.capabilities.db.prepare("UPDATE capability_installs SET install_path = 'bad'").run()).toThrow(
      "immutable"
    );
    rmSync(f.external, { recursive: true });
    expect(
      new CapabilityService(restored.capabilities, f.restoredSkills, [], offline, []).loader(f.skill.id).skill
        .instructions
    ).toBe("分析附件");
  });

  it("显式指定 Skill 根且不覆盖已存在目录", async () => {
    const f = await fixture();
    await expect(backupRuntimeData({ dataDir: f.dataDir, destination: join(f.root, "no-root") })).rejects.toThrow(
      "skillsDirectory"
    );
    await backupRuntimeData({ ...f, destination: f.backup });
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored })).rejects.toThrow("skillsDirectory");
    mkdirSync(f.restoredSkills);
    writeFileSync(join(f.restoredSkills, "sentinel"), "original");
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow("拒绝覆盖");
    expect(existsSync(f.restored)).toBe(false);
    expect(readFileSync(join(f.restoredSkills, "sentinel"), "utf8")).toBe("original");
  });

  it.each(["symlink", "hardlink"])("拒绝嵌套文件 %s", async (kind) => {
    const f = await fixture();
    const resource = join(f.skillPath, "references", "说明.txt");
    const outside = join(f.root, "outside");
    writeFileSync(outside, "离线辅助资源");
    rmSync(resource);
    if (kind === "hardlink") linkSync(outside, resource);
    else symlinkSync(outside, resource);
    await expect(backupRuntimeData({ ...f, destination: f.backup })).rejects.toThrow();
    expect(existsSync(join(f.backup, "backup-manifest.json"))).toBe(false);
  });

  it("拒绝嵌套符号链接目录及备份中的链接", async () => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    const prefix = join(f.backup, "assets", "blobs", f.uploaded.version.sha256.slice(0, 2));
    rmSync(prefix, { recursive: true });
    symlinkSync(join(f.dataDir, "assets", "blobs", f.uploaded.version.sha256.slice(0, 2)), prefix, "junction");
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("符号链接");
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow("符号链接");
    expect(manifest.files.length).toBeGreaterThan(1);
  });

  it.each([
    "snapshots/../outside",
    "snapshots/" + "a".repeat(64) + "/references/../../outside",
    "snapshots/" + "a".repeat(64) + "/C:escape",
    "snapshots/" + "a".repeat(64) + "/NUL.txt"
  ])("拒绝 Skill 非法路径 %s", async (path) => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    manifest.files.push({ ...manifest.files[0]!, root: "skills", path });
    writeManifest(f.backup, manifest);
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow("路径无效");
    expect(existsSync(f.restored)).toBe(false);
  });

  it("明确拒绝旧备份格式", async () => {
    const f = await fixture();
    await backupRuntimeData({ ...f, destination: f.backup });
    writeFileSync(join(f.backup, "backup-manifest.json"), JSON.stringify({ version: 1 }));
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("旧 v1");
    await expect(restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored })).rejects.toThrow("重新生成");
    expect(existsSync(f.restored)).toBe(false);
  });

  it("Skill 根可嵌套在新的数据目录内，后续备份仍按逻辑根定位", async () => {
    const f = await fixture();
    await backupRuntimeData({ ...f, destination: f.backup });
    const nested = join(f.restored, "managed", "skills");
    await restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: nested });
    const reopened = new SqliteRuntimeContextStore({
      databasePath: join(f.restored, "runtime-context.sqlite"),
      exclusiveOwner: true
    });
    onTestFinished(() => reopened.close());
    expect(
      new CapabilityService(reopened.capabilities, nested, [], offline, []).loader(f.skill.id).skill.instructions
    ).toBe("分析附件");
    reopened.close();
    await backupRuntimeData({
      dataDir: f.restored,
      skillsDirectory: nested,
      destination: join(f.root, "second-backup")
    });
    await verifyRuntimeBackup(join(f.root, "second-backup"));
  });

  it("拒绝 Skill 大小写重复路径和备份中的硬链接", async () => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    const resource = manifest.files.find((entry) => entry.path.endsWith("SKILL.md"))!;
    manifest.files.push({ ...resource, path: resource.path.replace("SKILL.md", "skill.MD") });
    writeManifest(f.backup, manifest);
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("重复路径");
    manifest.files.pop();
    writeManifest(f.backup, manifest);
    linkSync(join(f.backup, "skills", resource.path), join(f.root, "linked-resource"));
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("普通文件");
  });

  it("数据库摘要重算后仍验证外键完整性", async () => {
    const f = await fixture();
    const manifest = await backupRuntimeData({ ...f, destination: f.backup });
    const database = join(f.backup, "runtime-context.sqlite");
    const db = new Database(database);
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE assets SET current_version_id = 'missing' WHERE id = ?").run(f.uploaded.asset.id);
    db.close();
    const bytes = readFileSync(database);
    const file = manifest.files.find((entry) => entry.path === "runtime-context.sqlite")!;
    file.bytes = bytes.length;
    file.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeManifest(f.backup, manifest);
    await expect(verifyRuntimeBackup(f.backup)).rejects.toThrow("外键完整性");
    await expect(
      restoreRuntimeData({ backupDir: f.backup, dataDir: f.restored, skillsDirectory: f.restoredSkills })
    ).rejects.toThrow("外键完整性");
  });
});
