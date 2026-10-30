import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const metadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024),
    license: z.string().max(2048).optional(),
    compatibility: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().max(4096).optional()
  })
  .passthrough();

/** 标准 Agent Skill，不把外部声明解释为 Synapse 执行授权 */
export interface DirectorySkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly instructions: string;
  readonly contentDigest: string;
  readonly files: readonly { readonly path: string; readonly sizeBytes: number; readonly sha256: string }[];
}

/** 相对资源路径不能携带绝对路径、隐藏目录或编码穿越 */
export function validateSkillPath(path: string): string {
  if (
    !path ||
    path.length > 500 ||
    isAbsolute(path) ||
    /[\\:%]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    path.split("/").some((part) => !part || part.startsWith(".") || part === "..")
  )
    throw new Error("Invalid skill resource path");
  return path;
}

/** 标准说明与辅助资源加载器，所有文件必须是根目录内的普通文件 */
export class SkillDirectoryLoader {
  readonly root: string;
  readonly skill: DirectorySkill;
  /** 安装根目录来自 Runtime 快照，浏览器和模型不能指定宿主路径 */
  constructor(directory: string) {
    this.root = resolve(directory);
    if (lstatSync(this.root).isSymbolicLink()) throw new Error("Skill root cannot be a symlink");
    const files: { path: string; sizeBytes: number; sha256: string }[] = [];
    let total = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const relativePath = relative(this.root, path).split(sep).join("/");
        validateSkillPath(relativePath);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          throw new Error("Skill links and special files are forbidden");
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        total += stat.size;
        if (files.length >= 512 || total > 20 * 1024 * 1024 || stat.size > 2 * 1024 * 1024)
          throw new Error("Skill package limits exceeded");
        files.push({ path: relativePath, sizeBytes: stat.size, sha256: digest(readFileSync(path)) });
      }
    };
    walk(this.root);
    const manifest = readFileSync(join(this.root, "SKILL.md"), "utf8");
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(manifest);
    if (!match || manifest.length > 100_000) throw new Error("SKILL.md must contain bounded YAML frontmatter");
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw new Error("Invalid skill frontmatter");
    const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
    if (!match[2]?.trim()) throw new Error("Skill instructions cannot be empty");
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.skill = {
      name: metadata.name,
      description: metadata.description,
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
      instructions: match[2].trim(),
      files,
      contentDigest: digest(JSON.stringify(files))
    };
  }

  /** 按已登记的相对路径渐进读取，读取时重新验证摘要防止快照被篡改 */
  readResource(path: string, offset = 0, maxChars = 16000) {
    validateSkillPath(path);
    const entry = this.skill.files.find((file) => file.path === path);
    if (
      !entry ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > 32000
    )
      throw new Error("Invalid skill resource request");
    const target = join(this.root, path);
    const canonical = realpathSync(target);
    if (!canonical.startsWith(realpathSync(this.root) + sep) || lstatSync(target).isSymbolicLink())
      throw new Error("Skill resource escapes installed snapshot");
    const bytes = readFileSync(target);
    if (digest(bytes) !== entry.sha256) throw new Error("Skill snapshot integrity failure");
    const text = bytes.toString("utf8");
    return {
      path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      ...(bytes.includes(0) || text.includes("\uFFFD")
        ? { binary: true }
        : {
            text: text.slice(offset, offset + maxChars),
            offset,
            totalChars: text.length,
            hasMore: offset + maxChars < text.length
          })
    };
  }
}

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
