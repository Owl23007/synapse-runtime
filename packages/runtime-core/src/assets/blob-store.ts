import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ResourceOperationError } from "./types.js";

/** 经内容验证的本地 Blob，不暴露宿主文件路径 */
export interface VerifiedBlob {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
}

/** 内容寻址文件存储，先写 staging，再原子发布，失败绝不产生版本 */
export class AssetBlobStore {
  readonly #root: string;
  #pending: Promise<unknown> = Promise.resolve();
  /** 根目录与容量由管理员配置，调用者只能提交字节 */
  constructor(
    directory: string,
    readonly maxBytes: number
  ) {
    this.#root = resolve(directory);
  }

  /** 串行发布以保证并发写入不能绕过总容量限制 */
  write(input: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal): Promise<VerifiedBlob> {
    const result = this.#pending.then(() => this.#write(input, limit, signal));
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #write(input: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal): Promise<VerifiedBlob> {
    await this.#directory(this.#root);
    const staging = join(this.#root, "staging");
    await this.#directory(staging);
    const stage = join(staging, randomUUID());
    const file = await open(stage, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of input) {
        signal?.throwIfAborted();
        sizeBytes += chunk.byteLength;
        if (sizeBytes > limit) throw new ResourceOperationError(413, "asset_too_large");
        hash.update(chunk);
        if (head.length < 4096) head = Buffer.concat([head, Buffer.from(chunk).subarray(0, 4096 - head.length)]);
        await file.writeFile(chunk);
      }
      signal?.throwIfAborted();
      await file.sync();
      await file.close();
      const sha256 = hash.digest("hex");
      const directory = join(this.#root, "blobs", sha256.slice(0, 2));
      await this.#directory(join(this.#root, "blobs"));
      await this.#directory(directory);
      const target = join(directory, sha256);
      try {
        const existing = await this.read(sha256, sizeBytes);
        if (existing.length !== sizeBytes) throw new ResourceOperationError(409, "blob_integrity_failure");
      } catch (error) {
        if (!(error instanceof ResourceOperationError && error.code === "blob_unavailable")) throw error;
        if ((await this.#usedBytes()) + sizeBytes > this.maxBytes)
          throw new ResourceOperationError(413, "asset_storage_quota_exceeded");
        await rename(stage, target);
      }
      return { sha256, sizeBytes, detectedMime: sniffMime(head) };
    } finally {
      await file.close().catch(() => undefined);
      await unlink(stage).catch(() => undefined);
    }
  }

  /** 每次读取核对大小与内容摘要，损坏文件不能冒充历史版本 */
  async read(sha256: string, expectedSize: number): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ResourceOperationError(400, "invalid_blob_key");
    const path = join(this.#root, "blobs", sha256.slice(0, 2), sha256);
    try {
      for (const directory of [this.#root, join(this.#root, "blobs"), join(this.#root, "blobs", sha256.slice(0, 2))]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_blob_storage");
      }
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize)
        throw new ResourceOperationError(409, "blob_integrity_failure");
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256)
        throw new ResourceOperationError(409, "blob_integrity_failure");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ResourceOperationError(410, "blob_unavailable");
      throw error;
    }
  }

  /** 只清理过期的未发布 staging，历史 Blob 始终保留 */
  async cleanStaging(before = Date.now() - 3600_000): Promise<void> {
    const directory = join(this.#root, "staging");
    for (const path of [this.#root, directory]) {
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_blob_storage");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of entries) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < before) await unlink(path);
    }
  }

  async #directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_blob_storage");
  }
  async #usedBytes(): Promise<number> {
    const root = join(this.#root, "blobs");
    let bytes = 0;
    for (const prefix of await readdir(root)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const directory = join(root, prefix);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_blob_storage");
      for (const name of await readdir(directory)) {
        const file = await lstat(join(directory, name));
        if (!file.isFile() || file.isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_blob_storage");
        bytes += file.size;
      }
    }
    return bytes;
  }
}

/** 只识别安全的预览格式，其余内容统一下载 */
export function sniffMime(head: Uint8Array): string {
  const bytes = Buffer.from(head);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (!bytes.includes(0) && !bytes.toString("utf8").includes("\uFFFD")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
