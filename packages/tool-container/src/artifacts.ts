import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
  renameSync,
  existsSync
} from "node:fs";
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
  /** 展示类型不影响内容摘要，仅用于恢复最终附件 */
  readonly kind?: "file" | "image";
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
  createdAt: z.string(),
  kind: z.enum(["file", "image"]).optional()
});

const selectionSchema = z.object({
  selectedIds: z.array(z.string().uuid()).max(4096),
  discardedIds: z.array(z.string().uuid()).max(4096)
});

/** 当前运行最终产物选择，未选中和废弃文件仍保留历史元数据 */
export interface ArtifactSelection {
  readonly selectedIds: readonly string[];
  readonly excludedIds: readonly string[];
  readonly discardedIds: readonly string[];
}

/** 包含可信来源和创建时间的工件清单 */
export type ArtifactManifest = z.infer<typeof manifestSchema> & {
  readonly disposition?: "selected" | "candidate" | "discarded";
};

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

  /** 同轮同名同内容复用 ID，同名修订版替换最终选择，清单先于选择落盘 */
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
    const previous = this.#runArtifacts(scope.sessionId, scope.runId);
    const selection = this.selection(scope.sessionId, scope.runId);
    const reused = files.map((file) =>
      previous.find((item) => item.name === file.name && item.sha256 === digest(file.data))
    );
    for (const artifact of reused) if (artifact) this.read(scope.sessionId, artifact.id);
    const requiredBytes = files.reduce((sum, file, index) => sum + (reused[index] ? 0 : file.data.byteLength), 0);
    const used = readdirSync(this.directory)
      .filter((name) => name.endsWith(".bin"))
      .reduce((sum, name) => sum + lstatSync(join(this.directory, name)).size, 0);
    if (used + requiredBytes > this.limits.storageMaxBytes)
      throw new Error("工件存储配额已用尽，请由管理员清理过期工件");
    const created: string[] = [];
    try {
      const saved = files.map((file, index) => {
        const existing = reused[index];
        if (existing) return { id: existing.id, name: existing.name, size: existing.size, sha256: existing.sha256 };
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
        writeFileSync(
          manifest,
          JSON.stringify({ ...artifact, ...scope, kind: file.kind ?? "file", createdAt: new Date().toISOString() }),
          {
            flag: "wx",
            mode: 0o600
          }
        );
        created.push(manifest);
        return artifact;
      });
      const replaced = new Set(previous.filter((item) => names.has(item.name)).map((item) => item.id));
      this.#writeSelection(scope.sessionId, scope.runId, {
        selectedIds: [...selection.selectedIds.filter((id) => !replaced.has(id)), ...saved.map((item) => item.id)],
        discardedIds: selection.discardedIds.filter((id) => !saved.some((item) => item.id === id))
      });
      return saved;
    } catch (error) {
      for (const path of created) unlinkSync(path);
      throw error;
    }
  }

  /** 仅允许同会话读取工件，并校验内容摘要以拒绝损坏或被替换的文件 */
  read(sessionId: string, id: string): Artifact & { readonly data: Uint8Array } {
    const manifest = this.describe(sessionId, id);
    const binary = join(this.directory, `${id}.bin`);
    const info = lstatSync(binary);
    if (!info.isFile() || info.nlink !== 1 || info.size !== manifest.size || info.size > this.limits.maxArtifactBytes)
      throw new Error("工件文件无效或大小超限");
    const data = readFileSync(binary);
    if (digest(data) !== manifest.sha256) throw new Error("工件完整性校验失败");
    return { id, name: manifest.name, size: manifest.size, sha256: manifest.sha256, data };
  }

  /** 只读取清单并校验会话归属，不为列表加载二进制内容 */
  describe(sessionId: string, id: string): ArtifactManifest {
    z.string().uuid().parse(id);
    const manifestPath = join(this.directory, `${id}.json`);
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.nlink !== 1 || manifestStat.size > 16_384)
      throw new Error("工件清单无效");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest.sessionId !== sessionId || manifest.id !== id) throw new Error("工件不属于当前会话");
    const selection = this.#readSelection(manifest.sessionId, manifest.runId);
    return {
      ...manifest,
      disposition: selection?.discardedIds.includes(id)
        ? "discarded"
        : selection === undefined || selection.selectedIds.includes(id)
          ? "selected"
          : "candidate"
    };
  }

  /** 查询当前运行最终集合，旧清单缺少选择记录时保持原有交付语义 */
  selection(sessionId: string, runId: string): ArtifactSelection {
    const all = this.#runArtifacts(sessionId, runId);
    const stored = this.#readSelection(sessionId, runId);
    const selectedIds = stored?.selectedIds ?? all.map((item) => item.id);
    return {
      selectedIds,
      excludedIds: all.filter((item) => !selectedIds.includes(item.id)).map((item) => item.id),
      discardedIds: stored?.discardedIds ?? []
    };
  }

  /** 原子替换本轮最终集合，显式选择可以恢复此前废弃的候选 */
  select(sessionId: string, runId: string, ids: readonly string[]): ArtifactSelection {
    this.#validateSelection(sessionId, runId, ids);
    const current = this.selection(sessionId, runId);
    this.#writeSelection(sessionId, runId, {
      selectedIds: [...new Set(ids)],
      discardedIds: current.discardedIds.filter((id) => !ids.includes(id))
    });
    return this.selection(sessionId, runId);
  }

  /** 废弃候选并从最终集合移除，不删除内容与去重回执 */
  discard(sessionId: string, runId: string, ids: readonly string[]): ArtifactSelection {
    this.#validateSelection(sessionId, runId, ids);
    const current = this.selection(sessionId, runId);
    this.#writeSelection(sessionId, runId, {
      selectedIds: current.selectedIds.filter((id) => !ids.includes(id)),
      discardedIds: [...new Set([...current.discardedIds, ...ids])]
    });
    return this.selection(sessionId, runId);
  }

  #validateSelection(sessionId: string, runId: string, ids: readonly string[]): void {
    if (ids.length > 4096) throw new Error("最终产物数量超限");
    for (const id of ids) if (this.describe(sessionId, id).runId !== runId) throw new Error("工件不属于当前运行");
  }

  #runArtifacts(sessionId: string, runId: string): ArtifactManifest[] {
    const items: ArtifactManifest[] = [];
    let cursor = "";
    while (true) {
      const page = this.list(sessionId, cursor, 200);
      items.push(...page.items.filter((item) => item.runId === runId));
      if (!page.nextCursor) return items;
      cursor = page.nextCursor;
    }
  }

  #selectionPath(sessionId: string, runId: string): string {
    return join(
      this.directory,
      `selection-${createHash("sha256")
        .update(JSON.stringify([sessionId, runId]))
        .digest("hex")}.json`
    );
  }

  #readSelection(sessionId: string, runId: string): z.infer<typeof selectionSchema> | undefined {
    const path = this.#selectionPath(sessionId, runId);
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 512_000) throw new Error("工件选择记录无效");
    return selectionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  #writeSelection(
    sessionId: string,
    runId: string,
    value: { readonly selectedIds: readonly string[]; readonly discardedIds: readonly string[] }
  ): void {
    const record = selectionSchema.parse(value);
    const destination = this.#selectionPath(sessionId, runId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** 按工件标识分页列举当前会话清单，损坏清单不会被当成可下载工件 */
  list(
    sessionId: string,
    after = "",
    limit = 50
  ): { readonly items: readonly ArtifactManifest[]; readonly nextCursor?: string } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("工件分页大小无效");
    const items: ArtifactManifest[] = [];
    for (const name of readdirSync(this.directory).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (id <= after) continue;
      try {
        items.push(this.describe(sessionId, id));
      } catch {
        continue;
      }
      if (items.length > limit) break;
    }
    return { items: items.slice(0, limit), ...(items.length > limit ? { nextCursor: items[limit - 1]!.id } : {}) };
  }
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
