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
import { acquireDirectoryLease } from "./storage/sqlite/directory-lease.js";

const DATABASE = "runtime-context.sqlite";
const MANIFEST = "backup-manifest.json";
const INCOMPLETE = ".maintenance-incomplete";
const fileSchema = z
  .object({
    path: z.string().max(240),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    databaseVersion: z.number().int().nonnegative(),
    files: z.array(fileSchema).min(1).max(100_000)
  })
  .strict();

/** 完整数据快照的校验清单，不包含部署配置或环境变量 */
export type RuntimeBackupManifest = z.infer<typeof manifestSchema>;

/** 持有生产目录锁执行离线维护，只读打开原数据库且不运行迁移 */
export async function withOfflineRuntimeDatabase<T>(
  dataDir: string,
  operation: (db: Database.Database, directory: string) => T | Promise<T>
): Promise<T> {
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

/** 停机后备份 SQLite 一致性快照、工件与回执，清单最后提交 */
export async function backupRuntimeData(options: {
  readonly dataDir: string;
  readonly destination: string;
}): Promise<RuntimeBackupManifest> {
  return withOfflineRuntimeDatabase(options.dataDir, async (db, source) => {
    const destination = newDestination(source, options.destination);
    const release = reserveDestination(destination);
    try {
      assertDatabase(db);
      await db.backup(join(destination, DATABASE));
      // 将快照转换为独立数据库，后续只读校验不需要创建 WAL/SHM 边车文件
      const snapshot = new Database(join(destination, DATABASE));
      try {
        snapshot.pragma("journal_mode = DELETE");
        assertDatabase(snapshot);
      } finally {
        snapshot.close();
      }
      const files: RuntimeBackupManifest["files"] = [
        { path: DATABASE, ...(await hashFile(join(destination, DATABASE))) }
      ];
      for (const folder of ["artifacts", "artifact-deliveries"]) {
        const from = join(source, folder);
        if (!existsSync(from)) continue;
        regularDirectory(from);
        mkdirSync(join(destination, folder), { mode: 0o700 });
        for (const name of readdirSync(from).toSorted()) {
          const path = `${folder}/${name}`;
          validatePath(path);
          if (files.length >= 100_000) throw new Error("备份文件数量超限");
          // 逐文件复制避免同时打开大量句柄，文件内容以流处理
          // eslint-disable-next-line no-await-in-loop
          files.push({ path, ...(await copyFile(join(from, name), join(destination, folder, name))) });
        }
      }
      const manifest = manifestSchema.parse({
        version: 1,
        createdAt: new Date().toISOString(),
        databaseVersion: db.pragma("user_version", { simple: true }),
        files
      });
      writeFileSync(join(destination, MANIFEST), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
      unlinkSync(join(destination, INCOMPLETE));
      return manifest;
    } finally {
      release();
    }
  });
}

/** 校验完整标记、路径、摘要与 SQLite 完整性，不修改备份或触发迁移 */
export async function verifyRuntimeBackup(backupDir: string): Promise<RuntimeBackupManifest> {
  const source = realpathSync(backupDir);
  const manifest = readManifest(source);
  for (const file of manifest.files) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await hashFile(backupFile(source, file.path));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`备份内容校验失败：${file.path}`);
  }
  const db = new Database(join(source, DATABASE), { readonly: true, fileMustExist: true });
  try {
    assertDatabase(db);
  } finally {
    db.close();
  }
  return manifest;
}

/** 恢复到全新目录，完整校验完成前保留禁止启动标记，绝不覆盖原数据 */
export async function restoreRuntimeData(options: {
  readonly backupDir: string;
  readonly dataDir: string;
}): Promise<RuntimeBackupManifest> {
  const source = realpathSync(options.backupDir);
  const manifest = readManifest(source);
  const destination = newDestination(source, options.dataDir);
  const release = reserveDestination(destination);
  try {
    for (const file of manifest.files) {
      const target = join(destination, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // 复制过程中同步计算摘要，杜绝先验证后替换文件的窗口
      // eslint-disable-next-line no-await-in-loop
      const actual = await copyFile(backupFile(source, file.path), target);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
        throw new Error(`备份内容校验失败：${file.path}`);
    }
    const db = new Database(join(destination, DATABASE), { readonly: true, fileMustExist: true });
    try {
      assertDatabase(db);
    } finally {
      db.close();
    }
    unlinkSync(join(destination, INCOMPLETE));
    return manifest;
  } finally {
    release();
  }
}

function readManifest(directory: string): RuntimeBackupManifest {
  if (existsSync(join(directory, INCOMPLETE))) throw new Error("备份未完成，不能验证或恢复");
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (existsSync(join(directory, `${DATABASE}${suffix}`)))
      throw new Error("备份数据库存在外部日志，请使用未被运行时打开过的快照");
  const info = regularFile(join(directory, MANIFEST));
  if (info.size > 32_000_000) throw new Error("备份清单过大");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(directory, MANIFEST), "utf8")));
  const paths = new Set<string>();
  for (const file of manifest.files) {
    validatePath(file.path);
    const normalized = file.path.toLowerCase();
    if (paths.has(normalized)) throw new Error("备份清单包含重复路径");
    paths.add(normalized);
  }
  if (!paths.has(DATABASE)) throw new Error("备份缺少运行数据库");
  return manifest;
}

function validatePath(path: string): void {
  if (path === DATABASE) return;
  if (!/^(artifacts|artifact-deliveries)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(path))
    throw new Error("备份路径无效");
  const name = path.split("/")[1]!;
  if (name.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    throw new Error("备份文件名不受支持");
}

function backupFile(directory: string, path: string): string {
  validatePath(path);
  if (path.includes("/")) regularDirectory(join(directory, path.split("/")[0]!));
  return join(directory, ...path.split("/"));
}

function newDestination(source: string, requested: string): string {
  const absolute = resolve(requested);
  // 父目录必须已存在，解析真实父路径以拒绝符号链接造成的内外目录重叠
  const destination = join(realpathSync(dirname(absolute)), basename(absolute));
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
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
