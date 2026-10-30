import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ResourceOperationError,
  type Asset,
  type AssetVersion,
  type AssetSource,
  type AssetReference,
  type AssetIndex,
  type AssetQuery
} from "../../assets/types.js";

const assetColumns = `id, workspace_id AS workspaceId, display_name AS displayName, declared_mime AS declaredMime, declared_size_bytes AS declaredSizeBytes,
 current_version_id AS currentVersionId, fetch_state AS fetchState, fetch_error AS fetchError,
 created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`;
const versionColumns = `id, asset_id AS assetId, version_no AS versionNo, sha256, size_bytes AS sizeBytes,
 detected_mime AS detectedMime, blob_key AS blobKey, created_at AS createdAt`;

/** 与会话共享 SQLite 连接的资源索引，业务写入使用即时事务 */
export class SqliteAssetStore implements AssetIndex {
  /** 连接生命周期由上下文存储持有 */
  constructor(readonly db: Database.Database) {}

  /** 幂等观察来源，不把发现时间误写成内容版本时间 */
  observe(input: Parameters<AssetIndex["observe"]>[0]): Asset {
    const name = validName(input.name);
    if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 0))
      throw new ResourceOperationError(400, "invalid_declared_size");
    const locator = Object.fromEntries(Object.entries(input.locator).sort(([a], [b]) => a.localeCompare(b)));
    if (
      Object.keys(locator).length === 0 ||
      Object.entries(locator).some(
        ([key, value]) => !key || typeof value !== "string" || !value || /url|token|secret|cookie|password/i.test(key)
      )
    )
      throw new ResourceOperationError(400, "invalid_source_locator");
    // busid 可在通知和消息中缺省，同一 fileId 不应因此分裂成多个资源
    const identityLocator =
      input.kind === "qq_group"
        ? Object.fromEntries(Object.entries(locator).filter(([key]) => key !== "busid"))
        : locator;
    const sourceKey = createHash("sha256").update(JSON.stringify(identityLocator)).digest("hex");
    const observedAt = input.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) throw new ResourceOperationError(400, "invalid_observed_at");
    const time = new Date(observedAt).toISOString();
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT asset_id AS assetId, locator_json AS locatorJson FROM asset_sources WHERE workspace_id = ? AND source_kind = ? AND source_key = ?"
          )
          .get(input.workspaceId, input.kind, sourceKey) as { assetId: string; locatorJson: string } | undefined;
        if (existing) {
          if (input.kind === "qq_group" && locator.busid)
            this.db
              .prepare(
                "UPDATE asset_sources SET locator_json = ? WHERE workspace_id = ? AND source_kind = ? AND source_key = ?"
              )
              .run(
                JSON.stringify({ ...JSON.parse(existing.locatorJson), busid: locator.busid }),
                input.workspaceId,
                input.kind,
                sourceKey
              );
          this.db
            .prepare(
              "UPDATE asset_sources SET last_seen_at = MAX(last_seen_at, ?) WHERE workspace_id = ? AND source_kind = ? AND source_key = ?"
            )
            .run(time, input.workspaceId, input.kind, sourceKey);
          // 重复发现不能复活被管理员删除的逻辑资源
          return this.get(input.workspaceId, existing.assetId, true);
        }
        this.requireWorkspace(input.workspaceId);
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO assets (id, workspace_id, display_name, declared_mime, declared_size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(id, input.workspaceId, name, input.mime ?? null, input.size ?? null, time, time);
        this.db
          .prepare("INSERT INTO asset_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), input.workspaceId, id, input.kind, sourceKey, JSON.stringify(locator), time, time);
        return this.get(input.workspaceId, id);
      })
      .immediate();
  }

  /** 分页只返回元数据，游标按更新时间与资源 ID 排序 */
  list(workspaceId: string, input: AssetQuery = {}) {
    this.requireWorkspace(workspaceId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new ResourceOperationError(400, "invalid_page_size");
    let cursor: [string, string] | undefined;
    if (input.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string"))
          throw new Error();
        cursor = value as [string, string];
      } catch {
        throw new ResourceOperationError(400, "invalid_cursor");
      }
    }
    const rows = this.db
      .prepare(`SELECT ${assetColumns} FROM assets WHERE workspace_id = ? AND deleted_at IS NULL
      AND (? IS NULL OR instr(lower(display_name), lower(?)) > 0)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM asset_sources s WHERE s.asset_id = assets.id AND s.source_kind = ?))
      AND (? IS NULL OR (updated_at, id) < (?, ?)) ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(
        workspaceId,
        input.query ?? null,
        input.query ?? null,
        input.source ?? null,
        input.source ?? null,
        cursor?.[0] ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        limit + 1
      ) as Asset[];
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString("base64url") }
        : {})
    };
  }

  /** 所有单资源访问均带工作区条件，跨域与不存在返回相同错误 */
  get(workspaceId: string, assetId: string, includeDeleted = false): Asset {
    const row = this.db
      .prepare(
        `SELECT ${assetColumns} FROM assets WHERE id = ? AND workspace_id = ? AND (? OR deleted_at IS NULL) AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL)`
      )
      .get(assetId, workspaceId, includeDeleted ? 1 : 0, workspaceId) as Asset | undefined;
    if (!row) throw new ResourceOperationError(404, "asset_not_found");
    return row;
  }

  /** 显式版本读取先验证资源归属 */
  version(workspaceId: string, assetId: string, versionId: string, includeDeleted = false): AssetVersion {
    this.get(workspaceId, assetId, includeDeleted);
    const row = this.db
      .prepare(`SELECT ${versionColumns} FROM asset_versions WHERE id = ? AND asset_id = ?`)
      .get(versionId, assetId) as AssetVersion | undefined;
    if (!row) throw new ResourceOperationError(404, "asset_version_not_found");
    return row;
  }

  /** 仅由已写入 Blob 的服务调用，版本序号和当前头一起提交 */
  publish(
    workspaceId: string,
    assetId: string,
    blob: { sha256: string; sizeBytes: number; detectedMime: string }
  ): AssetVersion {
    return this.db
      .transaction(() => {
        const asset = this.get(workspaceId, assetId);
        if (asset.currentVersionId) {
          const current = this.version(workspaceId, assetId, asset.currentVersionId);
          if (current.sha256 === blob.sha256) return current;
        }
        const id = randomUUID();
        const time = new Date().toISOString();
        this.db
          .prepare(`INSERT INTO asset_versions (id, asset_id, version_no, sha256, size_bytes, detected_mime, blob_key, created_at)
        SELECT ?, ?, COALESCE(MAX(version_no), 0) + 1, ?, ?, ?, ?, ? FROM asset_versions WHERE asset_id = ?`)
          .run(id, assetId, blob.sha256, blob.sizeBytes, blob.detectedMime, blob.sha256, time, assetId);
        this.db
          .prepare(
            "UPDATE assets SET current_version_id = ?, updated_at = ?, fetch_state = NULL, fetch_error = NULL WHERE id = ?"
          )
          .run(id, time, assetId);
        return this.version(workspaceId, assetId, id);
      })
      .immediate();
  }

  /** 来源定位按需交给受控平台接口，列表阶段不会请求网络 */
  sources(workspaceId: string, assetId: string): readonly AssetSource[] {
    this.get(workspaceId, assetId, true);
    return (
      this.db
        .prepare(
          `SELECT id, workspace_id AS workspaceId, asset_id AS assetId, source_kind AS kind, source_key AS sourceKey, locator_json, observed_at AS observedAt, last_seen_at AS lastSeenAt FROM asset_sources WHERE asset_id = ? ORDER BY observed_at, id`
        )
        .all(assetId) as (Omit<AssetSource, "locator"> & { locator_json: string })[]
    ).map(({ locator_json, ...row }) => ({ ...row, locator: JSON.parse(locator_json) }));
  }

  /** 幂等记录引用，空版本只用于消息或工件的来源发现 */
  reference(input: Omit<AssetReference, "id" | "createdAt">): AssetReference {
    this.get(input.workspaceId, input.assetId);
    if (input.versionId) this.version(input.workspaceId, input.assetId, input.versionId);
    if (!input.refId || (["run", "task"].includes(input.refType) && !input.versionId))
      throw new ResourceOperationError(400, "version_required");
    this.db
      .prepare("INSERT OR IGNORE INTO asset_refs VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        randomUUID(),
        input.workspaceId,
        input.assetId,
        input.versionId,
        input.refType,
        input.refId,
        new Date().toISOString()
      );
    return this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, asset_id AS assetId, version_id AS versionId, ref_type AS refType, ref_id AS refId, created_at AS createdAt FROM asset_refs WHERE workspace_id = ? AND asset_id = ? AND version_id IS ? AND ref_type = ? AND ref_id = ?`
      )
      .get(input.workspaceId, input.assetId, input.versionId, input.refType, input.refId) as AssetReference;
  }

  /** 历史版本与引用保留，软删除只隐藏当前资源入口 */
  remove(workspaceId: string, assetId: string): void {
    this.get(workspaceId, assetId, true);
    this.db
      .prepare("UPDATE assets SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), assetId);
  }

  /** 修改展示名不联动远端平台 */
  rename(workspaceId: string, assetId: string, name: string): Asset {
    this.get(workspaceId, assetId);
    this.db
      .prepare("UPDATE assets SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(validName(name), new Date().toISOString(), assetId);
    return this.get(workspaceId, assetId);
  }

  /** 统一验证工作区，不创建第二套工作区模型 */
  requireWorkspace(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL").get(id))
      throw new ResourceOperationError(404, "workspace_not_found");
  }
}

/** 展示名不是路径，拒绝目录分隔符和控制字符 */
export function validName(name: string): string {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 255 ||
    /[\\/]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    name === "." ||
    name === ".."
  )
    throw new ResourceOperationError(400, "invalid_asset_name");
  return name.trim();
}
