import { unzipSync } from "fflate";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { validateSkillPath } from "./skill-directory.js";

/** 解包前检查 ZIP 目录和声明上限，拒绝链接、重复路径、ZIP64 及压缩炸弹 */
export async function extractSkillArchive(
  bytes: Uint8Array,
  destination: string,
  options: { stripRoot?: boolean; subdirectory?: string } = {}
): Promise<void> {
  if (bytes.length > 20 * 1024 * 1024) throw new Error("Skill archive too large");
  const buffer = Buffer.from(bytes);
  let end = -1;
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65557); position--)
    if (buffer.readUInt32LE(position) === 0x06054b50) {
      end = position;
      break;
    }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0)
    throw new Error("Invalid ZIP archive");
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  let total = 0;
  if (count > (options.stripRoot ? 20000 : 512) || count === 0 || position + buffer.readUInt32LE(end + 12) !== end)
    throw new Error("Invalid ZIP directory");
  const sizes = new Map<string, number>();
  const selected = new Set<string>();
  const roots = new Set<string>();
  const subdirectory = options.subdirectory ? validateSkillPath(options.subdirectory) + "/" : "";
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = buffer.readUInt16LE(position + 8);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extra = buffer.readUInt16LE(position + 30);
    const comment = buffer.readUInt16LE(position + 32);
    const mode = buffer.readUInt32LE(position + 38) >>> 16;
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    if (
      position + 46 + nameLength + extra + comment > end ||
      flags & 1 ||
      size === 0xffffffff ||
      (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000))
    )
      throw new Error("Unsafe ZIP entry");
    const archivePath = name.endsWith("/") ? name.slice(0, -1) : name;
    if (
      !archivePath ||
      isAbsolute(archivePath) ||
      /[\\:%]/.test(archivePath) ||
      [...archivePath].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      archivePath.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe ZIP path");
    roots.add(name.split("/")[0]!);
    if (sizes.has(name)) throw new Error("Duplicate ZIP entry");
    sizes.set(name, size);
    const stripped = options.stripRoot ? name.slice(name.indexOf("/") + 1) : name;
    if (!name.endsWith("/") && stripped.startsWith(subdirectory)) {
      const path = stripped.slice(subdirectory.length);
      // Git 的仓库管理文件不属于安装的 Skill 内容，未选中的大目录也不解压
      if (
        !options.stripRoot ||
        !path.split("/").some((part) => [".github", ".gitignore", ".gitattributes", ".editorconfig"].includes(part))
      ) {
        validateSkillPath(path);
        selected.add(name);
        total += size;
        if (selected.size > 512 || size > 2 * 1024 * 1024 || total > 20 * 1024 * 1024)
          throw new Error("Skill archive limits exceeded");
      }
    }
    position += 46 + nameLength + extra + comment;
  }
  if (options.stripRoot && roots.size !== 1) throw new Error("Git archive must have one root");
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (sizes.get(file.name) !== file.originalSize) throw new Error("ZIP metadata mismatch");
      return selected.has(file.name);
    }
  });
  if (Object.keys(files).length > count) throw new Error("ZIP directory mismatch");
  let written = 0;
  for (const [name, content] of Object.entries(files)) {
    if (content.length !== sizes.get(name)) throw new Error("ZIP size mismatch");
    const stripped = options.stripRoot ? name.slice(name.indexOf("/") + 1) : name;
    if (!stripped.startsWith(subdirectory)) continue;
    const path = validateSkillPath(stripped.slice(subdirectory.length));
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    written++;
  }
  if (!written) throw new Error("No skill files in archive");
}
