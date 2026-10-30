import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ResourceOperationError } from "./types.js";
import type { AssetService } from "./service.js";
import { sniffMime } from "./blob-store.js";

/** 管理员声明的只读实时目录，public 需要额外显式批准 */
export interface ReadonlyMount {
  readonly id: string;
  readonly root: string;
  readonly urlPrefix: string;
  readonly access: "private" | "authenticated" | "public";
  readonly allowPublic: boolean;
  readonly readOnly: true;
}

/** 挂载目录不批量导入 Asset，Agent 读取时才保存不可变内容 */
export class ReadonlyMounts {
  /** 根目录来自配置，工作区访问由调用方的可信作用域保证 */
  constructor(
    readonly mounts: readonly ReadonlyMount[],
    readonly maxBytes: number
  ) {
    if (
      new Set(mounts.map((mount) => mount.id)).size !== mounts.length ||
      new Set(mounts.map((mount) => mount.urlPrefix)).size !== mounts.length
    )
      throw new Error("Mount IDs and URL prefixes must be unique");
    if (mounts.some((mount) => !isAbsolute(mount.root) || (mount.access === "public" && !mount.allowPublic)))
      throw new Error("Mount configuration is invalid");
  }

  /** 管理视图不返回宿主绝对根目录 */
  list() {
    return this.mounts.map(({ root: _root, ...mount }) => mount);
  }

  /** 有界读取实时目录，拒绝隐藏目录、路径穿越及符号链接 */
  async entries(id: string, path = "") {
    const { target } = await this.#target(id, path, true);
    const entries = await readdir(target, { withFileTypes: true });
    return {
      items: entries
        .filter(
          (entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())
        )
        .slice(0, 200)
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
      truncated: entries.length > 200
    };
  }

  /** 读取时再次验证句柄和规范路径，浏览器内容变化不影响已保存的 Run 版本 */
  async read(id: string, path: string) {
    const { target, root } = await this.#target(id, path, false);
    const file = await open(target, "r");
    try {
      const before = await file.stat();
      const canonical = await realpath(target);
      if (!before.isFile() || before.size > this.maxBytes || !canonical.startsWith(root + sep))
        throw new ResourceOperationError(403, "mount_access_denied");
      const current = await lstat(target);
      if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev)
        throw new ResourceOperationError(409, "mount_file_changed");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await file.stat();
      if (
        offset !== bytes.length ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new ResourceOperationError(409, "mount_file_changed");
      return { bytes, mime: sniffMime(bytes.subarray(0, 4096)), name: path.split("/").at(-1)! };
    } finally {
      await file.close();
    }
  }

  /** 显式引用挂载文件时复制内容，后续实时目录修改不会影响历史 Run */
  async materialize(assets: AssetService, workspaceId: string, mountId: string, path: string) {
    const content = await this.read(mountId, path);
    const asset = assets.index.observe({ workspaceId, name: content.name, kind: "mount", locator: { mountId, path } });
    const version = await assets.saveContent(workspaceId, asset.id, content.bytes);
    return { asset, version };
  }

  async #target(id: string, path: string, directory: boolean) {
    const mount = this.mounts.find((mount) => mount.id === id);
    if (!mount) throw new ResourceOperationError(404, "mount_not_found");
    if (
      isAbsolute(path) ||
      /[\\:%]/.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      (path && path.split("/").some((part) => !part || part.startsWith(".")))
    )
      throw new ResourceOperationError(403, "mount_path_denied");
    try {
      if ((await lstat(mount.root)).isSymbolicLink()) throw new ResourceOperationError(403, "mount_symlink_denied");
      const root = await realpath(mount.root);
      const target = resolve(root, path);
      if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target)))
        throw new ResourceOperationError(403, "mount_path_denied");
      let cursor = root;
      for (const component of path.split("/").filter(Boolean)) {
        cursor = join(cursor, component);
        if ((await lstat(cursor)).isSymbolicLink()) throw new ResourceOperationError(403, "mount_symlink_denied");
      }
      const stat = await lstat(target);
      if (directory ? !stat.isDirectory() : !stat.isFile())
        throw new ResourceOperationError(404, "mount_entry_not_found");
      return { root, target, mount };
    } catch (error) {
      if (error instanceof ResourceOperationError) throw error;
      throw new ResourceOperationError(404, "mount_entry_not_found");
    }
  }
}
