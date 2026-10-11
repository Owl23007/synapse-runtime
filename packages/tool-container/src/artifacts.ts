import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ArtifactNameSchema, type ContainerSettings } from "./config.js";

/** 供模型和 DAG 引用的工件描述，不暴露宿主文件路径或文件内容 */
export interface Artifact {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** 经过容器返回校验的文件内容 */
export interface ArtifactContent {
  readonly name: string;
  readonly data: Uint8Array;
}

/** 工件所属的可信执行上下文，不能从模型参数读取 */
export interface ArtifactScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
}

const manifestSchema = z.object({
  id: z.string().uuid(),
  name: ArtifactNameSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string(),
  runId: z.string(),
  callId: z.string(),
  createdAt: z.string()
});

/** 工件持久化只接受字节内容，容器无法指定宿主路径或访问宿主目录 */
export class ArtifactStore {
  /** 根目录由应用数据目录派生，存储配额同时统计崩溃遗留的二进制文件 */
  constructor(
    private readonly directory: string,
    private readonly limits: Pick<
      ContainerSettings,
      "maxArtifacts" | "maxArtifactBytes" | "maxTotalBytes" | "storageMaxBytes"
    >
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** 成批保存文件与归属清单，清单最后写入以免暴露未完成内容 */
  save(scope: ArtifactScope, files: readonly ArtifactContent[]): readonly Artifact[] {
    if (files.length === 0 || files.length > this.limits.maxArtifacts) throw new Error("工件数量超限");
    let total = 0;
    const names = new Set<string>();
    for (const file of files) {
      ArtifactNameSchema.parse(file.name);
      if (names.has(file.name)) throw new Error("工件文件名重复");
      names.add(file.name);
      if (file.data.byteLength > this.limits.maxArtifactBytes) throw new Error("单个工件大小超限");
      total += file.data.byteLength;
    }
    if (total > this.limits.maxTotalBytes) throw new Error("工件总大小超限");
    const used = readdirSync(this.directory)
      .filter((name) => name.endsWith(".bin"))
      .reduce((sum, name) => sum + statSync(join(this.directory, name)).size, 0);
    if (used + total > this.limits.storageMaxBytes) throw new Error("工件存储配额已用尽，请由管理员清理过期工件");
    const created: string[] = [];
    try {
      return files.map((file) => {
        const artifact: Artifact = {
          id: randomUUID(),
          name: file.name,
          size: file.data.byteLength,
          sha256: digest(file.data)
        };
        const binary = join(this.directory, `${artifact.id}.bin`);
        const manifest = join(this.directory, `${artifact.id}.json`);
        writeFileSync(binary, file.data, { flag: "wx", mode: 0o600 });
        created.push(binary);
        writeFileSync(manifest, JSON.stringify({ ...artifact, ...scope, createdAt: new Date().toISOString() }), {
          flag: "wx",
          mode: 0o600
        });
        created.push(manifest);
        return artifact;
      });
    } catch (error) {
      for (const path of created) unlinkSync(path);
      throw error;
    }
  }

  /** 仅允许同会话读取工件，并校验内容摘要以拒绝损坏或被替换的文件 */
  read(sessionId: string, id: string): Artifact & { readonly data: Uint8Array } {
    z.string().uuid().parse(id);
    const manifestPath = join(this.directory, `${id}.json`);
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 16_384) throw new Error("工件清单无效");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest.sessionId !== sessionId || manifest.id !== id) throw new Error("工件不属于当前会话");
    const binary = join(this.directory, `${id}.bin`);
    const info = lstatSync(binary);
    if (!info.isFile() || info.nlink !== 1 || info.size !== manifest.size || info.size > this.limits.maxArtifactBytes)
      throw new Error("工件文件无效或大小超限");
    const data = readFileSync(binary);
    if (digest(data) !== manifest.sha256) throw new Error("工件完整性校验失败");
    return { id, name: manifest.name, size: manifest.size, sha256: manifest.sha256, data };
  }
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
