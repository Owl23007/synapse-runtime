import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import { SkillDirectoryLoader } from "@synapse/runtime-resources";
import { acquireDirectoryLease } from "./storage/sqlite/directory-lease.js";

const DATABASE = "runtime-context.sqlite";
const MANIFEST = "backup-manifest.json";
const INCOMPLETE = ".maintenance-incomplete";
const artifactSchema = z.object({
  id: z.string().uuid(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const fileSchema = z
  .object({
    root: z.enum(["data", "skills"]),
    path: z.string().max(1000),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(2),
    roots: z
      .array(z.enum(["data", "skills"]))
      .min(1)
      .max(2),
    createdAt: z.string().datetime(),
    databaseVersion: z.number().int().nonnegative(),
    files: z.array(fileSchema).min(1).max(100_000)
  })
  .strict();

/** v2 快照清单以逻辑根和相对路径定位文件，不包含部署配置或必须保留的宿主路径 */
export type RuntimeBackupManifest = z.infer<typeof manifestSchema>;

/** 持有生产目录锁执行离线维护，只读打开原数据库且不运行迁移 */
export async function withOfflineRuntimeDatabase<T>(
  dataDir: string,
  operation: (db: Database.Database, directory: string) => T | Promise<T>
): Promise<T> {
  regularDirectory(dataDir);
  const directory = realpathSync(dataDir);
  const databasePath = join(directory, DATABASE);
  regularFile(databasePath);
  const release = acquireDirectoryLease(databasePath);
  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    return await operation(db, directory);
  } finally {
    db?.close();
    release();
  }
}

/** 备份全部托管文件，Skill 根显式提供，清单最后提交 */
export async function backupRuntimeData(options: {
  readonly dataDir: string;
  readonly skillsDirectory?: string;
  readonly destination: string;
}): Promise<RuntimeBackupManifest> {
  return withOfflineRuntimeDatabase(options.dataDir, async (db, source) => {
    const destination = newDestination(source, options.destination);
    if (options.skillsDirectory) regularDirectory(options.skillsDirectory);
    const skills = options.skillsDirectory ? realpathSync(options.skillsDirectory) : undefined;
    if (skills) newDestination(skills, destination);
    const installs = skillRows(db);
    for (const row of installs) {
      if (row.install_path !== null) newDestination(realpathSync(row.install_path), destination);
    }
    const release = reserveDestination(destination);
    try {
      assertDatabase(db);
      const roots: RuntimeBackupManifest["roots"] =
        installs.length || (skills && existsSync(join(skills, "snapshots"))) ? ["data", "skills"] : ["data"];
      const files: RuntimeBackupManifest["files"] = [];
      await validateResources(db, source, skills, undefined, true);
      await db.backup(join(destination, DATABASE));
      const snapshot = new Database(join(destination, DATABASE));
      try {
        snapshot.pragma("journal_mode = DELETE");
        // 只规范化备份副本，不改写旧部署与运行依赖的安装身份
        if (installs.some((row) => row.install_path !== null)) {
          const trigger = snapshot
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'capability_snapshot_immutable'")
            .get() as { sql: string } | undefined;
          snapshot.transaction(() => {
            snapshot.exec("DROP TRIGGER IF EXISTS capability_snapshot_immutable");
            snapshot.prepare("UPDATE capability_installs SET install_path = NULL WHERE kind = 'skill'").run();
            if (trigger) snapshot.exec(trigger.sql);
          })();
        }
        assertDatabase(snapshot);
      } finally {
        snapshot.close();
      }
      files.push({ root: "data", path: DATABASE, ...(await hashFile(join(destination, DATABASE))) });
      for (const folder of ["artifacts", "artifact-deliveries", "assets/blobs"]) {
        const from = join(source, folder);
        if (!existsSync(from)) continue;
        checkParents(source, folder);
        // eslint-disable-next-line no-await-in-loop
        await copyTree(from, folder, "data", destination, files);
      }
      const copied = new Set<string>();
      if (skills && existsSync(join(skills, "snapshots"))) {
        await copyTree(join(skills, "snapshots"), "snapshots", "skills", destination, files);
        for (const file of files) if (file.root === "skills") copied.add(file.path.split("/")[1]!);
      }
      for (const row of installs) {
        if (copied.has(row.content_digest)) continue;
        copied.add(row.content_digest);
        // eslint-disable-next-line no-await-in-loop
        await copyTree(
          skillLocation(row, skills, true),
          `snapshots/${row.content_digest}`,
          "skills",
          destination,
          files
        );
      }
      const manifest = manifestSchema.parse({
        version: 2,
        roots,
        createdAt: new Date().toISOString(),
        databaseVersion: db.pragma("user_version", { simple: true }),
        files
      });
      validateManifestPaths(manifest);
      await verifyDatabase(destination, join(destination, "skills"), manifest);
      writeFileSync(join(destination, MANIFEST), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
      unlinkSync(join(destination, INCOMPLETE));
      return manifest;
    } finally {
      release();
    }
  });
}

/** 校验逻辑根、文件摘要、数据库引用及 Skill 内容摘要，不运行迁移 */
export async function verifyRuntimeBackup(backupDir: string): Promise<RuntimeBackupManifest> {
  regularDirectory(backupDir);
  const source = realpathSync(backupDir);
  const manifest = readManifest(source);
  for (const file of manifest.files) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await hashFile(backupFile(source, file));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`备份内容校验失败：${file.path}`);
  }
  await verifyDatabase(source, join(source, "skills"), manifest);
  return manifest;
}

/** 恢复到全新数据与 Skill 根，全部引用校验通过前保留禁止启动标记 */
export async function restoreRuntimeData(options: {
  readonly backupDir: string;
  readonly dataDir: string;
  readonly skillsDirectory?: string;
}): Promise<RuntimeBackupManifest> {
  regularDirectory(options.backupDir);
  const source = realpathSync(options.backupDir);
  const manifest = readManifest(source);
  const destination = newDestination(source, options.dataDir);
  const hasSkills = manifest.roots.includes("skills");
  if (hasSkills && !options.skillsDirectory) throw new Error("恢复 Skill 必须显式指定 skillsDirectory / --skills-dir");
  // Skill 根允许放在新数据目录内，但不能与数据逻辑根占用同一子树
  const requestedSkills = hasSkills ? resolve(options.skillsDirectory!) : undefined;
  const nestedSkills =
    requestedSkills !== undefined && within(destination, requestedSkills) && destination !== requestedSkills;
  const skills =
    requestedSkills === undefined
      ? undefined
      : nestedSkills
        ? requestedSkills
        : newDestination(source, requestedSkills);
  if (skills) {
    if (nestedSkills) {
      const first = relative(destination, skills).split(sep)[0]!.toLowerCase();
      if (
        [
          "assets",
          "artifacts",
          "artifact-deliveries",
          DATABASE,
          INCOMPLETE,
          MANIFEST,
          ".runtime-lease.sqlite"
        ].includes(first)
      )
        throw new Error("Skill 根与数据资源路径重叠");
    } else newDestination(destination, skills);
    if (existsSync(skills)) throw new Error("Skill 目标目录已存在，拒绝覆盖");
  }
  if (existsSync(destination)) throw new Error("数据目标目录已存在，拒绝覆盖");
  const release = reserveDestination(destination);
  let releaseSkills: (() => void) | undefined;
  try {
    if (skills) {
      if (nestedSkills) mkdirSync(dirname(skills), { recursive: true, mode: 0o700 });
      releaseSkills = reserveDestination(skills);
    }
    for (const file of manifest.files) {
      const root = file.root === "data" ? destination : skills!;
      const target = join(root, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // 复制时同步校验，避免先校验后替换文件
      // eslint-disable-next-line no-await-in-loop
      const actual = await copyFile(backupFile(source, file), target);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
        throw new Error(`备份内容校验失败：${file.path}`);
    }
    await verifyDatabase(destination, skills, manifest);
    if (skills) unlinkSync(join(skills, INCOMPLETE));
    unlinkSync(join(destination, INCOMPLETE));
    return manifest;
  } finally {
    releaseSkills?.();
    release();
  }
}

async function verifyDatabase(data: string, skills: string | undefined, manifest: RuntimeBackupManifest) {
  const db = new Database(join(data, DATABASE), { readonly: true, fileMustExist: true });
  try {
    assertDatabase(db);
    if (db.pragma("user_version", { simple: true }) !== manifest.databaseVersion)
      throw new Error("数据库版本与清单不一致");
    await validateResources(db, data, skills, manifest);
  } finally {
    db.close();
  }
}

function readManifest(directory: string): RuntimeBackupManifest {
  if (existsSync(join(directory, INCOMPLETE))) throw new Error("备份未完成，不能验证或恢复");
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (existsSync(join(directory, `${DATABASE}${suffix}`)))
      throw new Error("备份数据库存在外部日志，请使用未被运行时打开过的快照");
  const info = regularFile(join(directory, MANIFEST));
  if (info.size > 32_000_000) throw new Error("备份清单过大");
  const value = JSON.parse(readFileSync(join(directory, MANIFEST), "utf8"));
  if (value.version === 1) throw new Error("旧 v1 备份未覆盖 Blob 与 Skill，请从原部署重新生成 v2 备份");
  const manifest = manifestSchema.parse(value);
  validateManifestPaths(manifest);
  return manifest;
}

function validateManifestPaths(manifest: RuntimeBackupManifest) {
  const roots = new Set(manifest.roots);
  if (roots.size !== manifest.roots.length || !roots.has("data")) throw new Error("备份逻辑根无效");
  const paths = new Set<string>();
  for (const file of manifest.files) {
    validatePath(file.path, file.root);
    if (!roots.has(file.root)) throw new Error("备份逻辑根缺失");
    const key = `${file.root}/${file.path}`.toLowerCase();
    if (paths.has(key)) throw new Error("备份清单包含重复路径");
    paths.add(key);
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 2) {
      parts.pop();
      if (paths.has(parts.join("/"))) throw new Error("备份路径无效：文件与目录冲突");
    }
  }
  if (!paths.has(`data/${DATABASE}`)) throw new Error("备份缺少运行数据库");
}

function validatePath(path: string, root: "data" | "skills" = "data"): void {
  if (
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    path
      .split("/")
      .some(
        (name) =>
          !name ||
          name === "." ||
          name === ".." ||
          /[\\:%<>"|?*]/.test(name) ||
          /[. ]$/.test(name) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
      )
  )
    throw new Error("备份路径无效");
  const allowed =
    root === "data"
      ? path === DATABASE ||
        /^(artifacts|artifact-deliveries)\/.+/.test(path) ||
        /^assets\/blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path)
      : /^snapshots\/[a-f0-9]{64}\/.+/.test(path);
  if (!allowed || path.length > 1000) throw new Error("备份路径无效");
}

function checkParents(root: string, path: string) {
  regularDirectory(root);
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    regularDirectory(current);
  }
}

function backupFile(directory: string, file: RuntimeBackupManifest["files"][number]): string {
  validatePath(file.path, file.root);
  const root = file.root === "data" ? directory : join(directory, "skills");
  checkParents(root, file.path);
  return join(root, ...file.path.split("/"));
}

async function copyTree(
  from: string,
  path: string,
  root: "data" | "skills",
  destination: string,
  files: RuntimeBackupManifest["files"]
) {
  regularDirectory(from);
  for (const name of readdirSync(from).toSorted()) {
    const source = join(from, name);
    const entryPath = `${path}/${name}`;
    if (lstatSync(source).isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await copyTree(source, entryPath, root, destination, files);
      continue;
    }
    validatePath(entryPath, root);
    if (files.length >= 100_000) throw new Error("备份文件数量超限");
    const target = join(destination, ...(root === "skills" ? ["skills"] : []), ...entryPath.split("/"));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // eslint-disable-next-line no-await-in-loop
    files.push({ root, path: entryPath, ...(await copyFile(source, target)) });
  }
}

interface SkillRow {
  content_digest: string;
  install_path: string | null;
  metadata_json: string;
}
function skillRows(db: Database.Database): SkillRow[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_installs'").get()) return [];
  return db
    .prepare("SELECT content_digest, install_path, metadata_json FROM capability_installs WHERE kind = 'skill'")
    .all() as SkillRow[];
}
function skillLocation(row: SkillRow, skills: string | undefined, legacy = false): string {
  if (!/^[a-f0-9]{64}$/.test(row.content_digest)) throw new Error("Skill 内容摘要无效");
  if (row.install_path !== null) {
    if (!legacy || !isAbsolute(row.install_path)) throw new Error("Skill 快照仍依赖旧安装路径，请重新备份");
    regularDirectory(row.install_path);
    return row.install_path;
  }
  if (!skills) throw new Error("备份 Skill 必须显式指定 skillsDirectory / --skills-dir");
  checkParents(skills, `snapshots/${row.content_digest}`);
  return join(skills, "snapshots", row.content_digest);
}

async function validateResources(
  db: Database.Database,
  data: string,
  skills?: string,
  manifest?: RuntimeBackupManifest,
  legacy = false
) {
  const listed = manifest ? new Map(manifest.files.map((file) => [`${file.root}/${file.path}`, file])) : undefined;
  const requireFile = async (
    root: "data" | "skills",
    path: string,
    directory: string,
    bytes: number,
    sha256: string
  ) => {
    validatePath(path, root);
    if (listed && !listed.has(`${root}/${path}`)) throw new Error(`数据库引用未包含在备份清单：${root}/${path}`);
    checkParents(directory, path);
    const actual = await hashFile(join(directory, path));
    if (actual.bytes !== bytes || actual.sha256 !== sha256) throw new Error(`数据库引用内容校验失败：${path}`);
  };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_versions'").get()) {
    const versions = db.prepare("SELECT blob_key, size_bytes, sha256 FROM asset_versions").all() as {
      blob_key: string;
      size_bytes: number;
      sha256: string;
    }[];
    for (const row of versions) {
      // eslint-disable-next-line no-await-in-loop
      await requireFile(
        "data",
        `assets/blobs/${row.blob_key.slice(0, 2)}/${row.blob_key}`,
        data,
        row.size_bytes,
        row.sha256
      );
    }
  }
  for (const row of skillRows(db)) {
    const loader = new SkillDirectoryLoader(skillLocation(row, skills, legacy));
    const metadata = JSON.parse(row.metadata_json);
    if (
      loader.skill.contentDigest !== row.content_digest ||
      JSON.stringify(loader.skill.files) !== JSON.stringify(metadata.files)
    )
      throw new Error("Skill 快照内容摘要或文件索引不一致");
    for (const file of loader.skill.files) {
      if (listed && !listed.has(`skills/snapshots/${row.content_digest}/${file.path}`))
        throw new Error("Skill 快照文件未包含在备份清单");
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'run_dependencies' AND type = 'table'").get()) {
    const dependencies = db.prepare("SELECT run_id, snapshot_json FROM run_dependencies").iterate() as Iterable<{
      run_id: string;
      snapshot_json: string;
    }>;
    for (const row of dependencies) {
      const snapshot = z
        .object({
          assets: z.array(z.object({ assetId: z.string(), versionId: z.string(), sha256: z.string() })),
          skills: z.array(z.object({ installId: z.string(), contentDigest: z.string() }))
        })
        .parse(JSON.parse(row.snapshot_json));
      for (const asset of snapshot.assets) {
        if (
          !db
            .prepare("SELECT 1 FROM asset_versions WHERE id = ? AND asset_id = ? AND sha256 = ?")
            .get(asset.versionId, asset.assetId, asset.sha256)
        )
          throw new Error("Run 附件依赖摘要或引用不一致");
      }
      for (const skill of snapshot.skills) {
        if (
          !db
            .prepare(
              "SELECT 1 FROM capability_installs i JOIN run_capabilities r ON r.install_id = i.id WHERE r.run_id = ? AND i.id = ? AND i.kind = 'skill' AND i.content_digest = ?"
            )
            .get(row.run_id, skill.installId, skill.contentDigest)
        )
          throw new Error("Run Skill 依赖摘要或引用不一致");
      }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'run_events' AND type = 'table'").get()) {
    const events = db
      .prepare("SELECT record FROM run_events WHERE json_extract(record, '$.type') = 'artifact_created'")
      .iterate() as Iterable<{ record: string }>;
    for (const row of events) {
      const artifact = artifactSchema.parse(JSON.parse(row.record).data.artifact);
      const path = `artifacts/${artifact.id}.json`;
      checkParents(data, path);
      regularFile(join(data, path));
      const stored = artifactSchema.parse(JSON.parse(readFileSync(join(data, path), "utf8")));
      if (
        stored.id !== artifact.id ||
        stored.size !== artifact.size ||
        stored.sha256 !== artifact.sha256 ||
        (listed && !listed.has(`data/${path}`))
      )
        throw new Error("Run 工件引用与文件索引不一致");
    }
  }
  // Artifact 以 JSON 而非 SQLite 保存文件索引，需要验证指向的二进制
  const artifacts = join(data, "artifacts");
  if (existsSync(artifacts)) {
    regularDirectory(artifacts);
    for (const name of readdirSync(artifacts)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      regularFile(join(artifacts, name));
      const artifact = artifactSchema.parse(JSON.parse(readFileSync(join(artifacts, name), "utf8")));
      if (name !== `${artifact.id}.json`) throw new Error("工件索引身份不一致");
      // eslint-disable-next-line no-await-in-loop
      await requireFile("data", `artifacts/${artifact.id}.bin`, data, artifact.size, artifact.sha256);
    }
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function newDestination(source: string, requested: string): string {
  const absolute = resolve(requested);
  // 父目录必须已存在，解析真实父路径以拒绝符号链接造成的内外目录重叠
  const destination = join(realpathSync(dirname(absolute)), basename(absolute));
  if (within(source, destination) || within(destination, source)) throw new Error("源目录与目标目录不能重叠");
  return destination;
}

function reserveDestination(directory: string): () => void {
  mkdirSync(directory, { mode: 0o700 });
  const release = acquireDirectoryLease(join(directory, DATABASE));
  try {
    writeFileSync(join(directory, INCOMPLETE), "维护未完成，请勿启动运行时；原数据保持不变\n", {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

function regularDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error("维护不接受符号链接目录");
}

function regularFile(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1) throw new Error("维护只接受独立普通文件");
  return info;
}

function assertDatabase(db: Database.Database): void {
  const result = db.pragma("quick_check", { simple: true });
  if (result !== "ok") throw new Error("SQLite 完整性校验失败");
  if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("SQLite 外键完整性校验失败");
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = regularFile(path);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  assertUnchanged(path, before, bytes);
  return { bytes, sha256: hash.digest("hex") };
}

async function copyFile(source: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const before = regularFile(source);
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      }
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 })
  );
  assertUnchanged(source, before, bytes);
  return { bytes, sha256: hash.digest("hex") };
}

function assertUnchanged(path: string, before: ReturnType<typeof regularFile>, bytes: number): void {
  const after = regularFile(path);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== bytes ||
    after.size !== bytes
  )
    throw new Error("维护期间源文件发生变化，结果未提交");
}
