import { createHash, randomUUID } from "node:crypto";
import type { SqliteAssetStore } from "../storage/sqlite/asset-store.js";
import type { AssetBlobStore } from "./blob-store.js";
import {
  ResourceOperationError,
  type AssetAttachment,
  type AssetScope,
  type AssetSource,
  type AssetVersion
} from "./types.js";

/** 来源解析器只返回受控字节流，临时地址永不持久化 */
export type AssetSourceReader = (source: AssetSource, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;

/** 文件使用闭环，持久化索引与本地内容分别承担职责 */
export class AssetService {
  readonly #fetches = new Map<string, Promise<AssetVersion>>();
  readonly #uploads = new Set<string>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #shutdown = new AbortController();
  /** 限额来自宿主配置，来源获取只由应用层注入 */
  constructor(
    readonly index: SqliteAssetStore,
    readonly blobs: AssetBlobStore,
    readonly limits: { maxNativeUploadBytes: number; maxRemoteFetchBytes: number; maxConcurrentFetches: number },
    readonly readSource?: AssetSourceReader
  ) {}

  /** 管理员通过已鉴权入口查看资源，内容仍按工作区和版本校验 */
  locate(assetId: string, workspaceId?: string): string {
    const row = this.index.db.prepare("SELECT workspace_id AS id FROM assets WHERE id = ?").get(assetId) as
      | { id: string }
      | undefined;
    if (!row || (workspaceId && workspaceId !== row.id)) throw new ResourceOperationError(404, "asset_not_found");
    this.index.get(row.id, assetId, true);
    return row.id;
  }

  /** 查看来源、历史版本和因果关系，不读取 Blob */
  detail(assetId: string, workspaceId?: string) {
    const scope = this.locate(assetId, workspaceId);
    const asset = this.index.get(scope, assetId, true);
    const versionRows = this.index.db
      .prepare("SELECT id FROM asset_versions WHERE asset_id = ? ORDER BY version_no DESC LIMIT 200")
      .all(assetId) as { id: string }[];
    const refs = this.index.db
      .prepare(
        "SELECT ref_type AS refType, ref_id AS refId, version_id AS versionId, created_at AS createdAt FROM asset_refs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 200"
      )
      .all(assetId);
    return {
      asset,
      sources: this.index.sources(scope, assetId),
      versions: versionRows.map((row) => this.index.version(scope, assetId, row.id, true)),
      refs
    };
  }

  /** 触发运行时只收集有界文件候选；精确附件和 Reply 来源优先，不下载内容 */
  candidates(
    workspaceId: string,
    message: import("@synapse/runtime-protocol").SynapseMessage,
    channelId: string,
    conversationId: string
  ) {
    const explicit =
      message.assets?.map((ref) => ({ ...ref, displayName: this.index.get(workspaceId, ref.assetId).displayName })) ??
      [];
    const reply = message.replyTo?.messageId;
    const related = reply
      ? this.index.db
          .prepare(
            "SELECT asset_id AS assetId, version_id AS versionId FROM asset_refs WHERE workspace_id = ? AND ref_type = 'message' AND ref_id = ? LIMIT 10"
          )
          .all(workspaceId, `${channelId}:${conversationId}:${reply}`)
      : [];
    return {
      attachments: explicit,
      replyAttachments: related,
      recent: this.index.list(workspaceId, { limit: 10 }).items.map((asset) => ({
        assetId: asset.id,
        name: asset.displayName,
        currentVersionId: asset.currentVersionId,
        updatedAt: asset.updatedAt,
        cached: !!asset.currentVersionId
      }))
    };
  }

  /** 选中工件显式导入资源库，不改变交付回执与 Artifact 生命周期 */
  publishArtifact(input: { workspaceId: string; artifactId: string; runId: string; name: string; bytes: Uint8Array }) {
    return this.#track(() => this.#publishArtifact(input));
  }

  async #publishArtifact(input: {
    workspaceId: string;
    artifactId: string;
    runId: string;
    name: string;
    bytes: Uint8Array;
  }) {
    const asset = this.index.observe({
      workspaceId: input.workspaceId,
      name: input.name,
      kind: "artifact",
      locator: { artifactId: input.artifactId, runId: input.runId }
    });
    const blob = await this.blobs.write(toStream(input.bytes), this.limits.maxRemoteFetchBytes);
    const version = this.index.publish(input.workspaceId, asset.id, blob);
    this.index.reference({
      workspaceId: input.workspaceId,
      assetId: asset.id,
      versionId: version.id,
      refType: "artifact",
      refId: input.artifactId
    });
    this.index.reference({
      workspaceId: input.workspaceId,
      assetId: asset.id,
      versionId: version.id,
      refType: "run",
      refId: input.runId
    });
    return { asset, version };
  }

  /** 两阶段上传初始化，同一幂等键不能改变参数 */
  beginUpload(
    workspaceId: string,
    input: { name: string; size: number; mime?: string | undefined; idempotencyKey: string; assetId?: string }
  ) {
    this.index.requireWorkspace(workspaceId);
    if (
      !input.idempotencyKey?.trim() ||
      input.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > this.limits.maxNativeUploadBytes
    )
      throw new ResourceOperationError(400, "invalid_upload");
    const parameters = JSON.stringify([input.name, input.size, input.mime ?? null, input.assetId ?? null]);
    return this.index.db
      .transaction(() => {
        const existing = this.index.db
          .prepare(
            "SELECT id, parameters_json AS parameters, expires_at AS expiresAt, version_id AS versionId FROM asset_uploads WHERE workspace_id = ? AND idempotency_key = ?"
          )
          .get(workspaceId, input.idempotencyKey) as
          | { id: string; parameters: string; expiresAt: string; versionId: string | null }
          | undefined;
        if (existing) {
          if (existing.parameters !== parameters) throw new ResourceOperationError(409, "upload_idempotency_conflict");
          return { uploadId: existing.id, expiresAt: existing.expiresAt, versionId: existing.versionId };
        }
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        // 初始化只创建逻辑资源，不发布空白版本
        const asset = input.assetId
          ? this.index.get(workspaceId, input.assetId)
          : this.index.observe({
              workspaceId,
              name: input.name,
              size: input.size,
              kind: "native",
              locator: { uploadId: id },
              ...(input.mime ? { mime: input.mime } : {})
            });
        this.index.db
          .prepare("INSERT INTO asset_uploads VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
          .run(id, workspaceId, asset.id, input.idempotencyKey, parameters, input.size, expiresAt);
        return { uploadId: id, assetId: asset.id, expiresAt, versionId: null };
      })
      .immediate();
  }

  /** 原始二进制上传完成后才发布版本，中断和大小不符仅留下可清理 staging */
  upload(uploadId: string, bytes: Uint8Array, signal?: AbortSignal) {
    return this.#track(() =>
      this.#upload(uploadId, bytes, signal ? AbortSignal.any([signal, this.#shutdown.signal]) : this.#shutdown.signal)
    );
  }

  async #upload(uploadId: string, bytes: Uint8Array, signal?: AbortSignal) {
    const row = this.index.db
      .prepare(
        "SELECT workspace_id AS workspaceId, asset_id AS assetId, expected_size AS size, version_id AS versionId, expires_at AS expiresAt FROM asset_uploads WHERE id = ?"
      )
      .get(uploadId) as
      | { workspaceId: string; assetId: string; size: number; versionId: string | null; expiresAt: string }
      | undefined;
    if (!row) throw new ResourceOperationError(404, "upload_not_found");
    this.index.get(row.workspaceId, row.assetId);
    if (row.size !== bytes.byteLength) throw new ResourceOperationError(409, "upload_size_mismatch");
    if (this.#uploads.has(uploadId)) throw new ResourceOperationError(409, "upload_in_progress");
    if (!row.versionId && row.expiresAt < new Date().toISOString())
      throw new ResourceOperationError(410, "upload_expired");
    this.#uploads.add(uploadId);
    try {
      if (
        row.versionId &&
        this.index.version(row.workspaceId, row.assetId, row.versionId).sha256 !==
          createHash("sha256").update(bytes).digest("hex")
      )
        throw new ResourceOperationError(409, "upload_content_conflict");
      const blob = await this.blobs.write(toStream(bytes), this.limits.maxNativeUploadBytes, signal);
      if (row.versionId) {
        const version = this.index.version(row.workspaceId, row.assetId, row.versionId);
        if (version.sha256 !== blob.sha256) throw new ResourceOperationError(409, "upload_content_conflict");
        return { asset: this.index.get(row.workspaceId, row.assetId), version };
      }
      const version = this.index.db
        .transaction(() => {
          const published = this.index.publish(row.workspaceId, row.assetId, blob);
          this.index.db.prepare("UPDATE asset_uploads SET version_id = ? WHERE id = ?").run(published.id, uploadId);
          return published;
        })
        .immediate();
      return { asset: this.index.get(row.workspaceId, row.assetId), version };
    } finally {
      this.#uploads.delete(uploadId);
    }
  }

  /** 并发合并同一物化请求，缓存存在时不访问平台 */
  materialize(workspaceId: string, assetId: string): Promise<AssetVersion> {
    return this.#track(() => this.#resolveMaterialization(workspaceId, assetId));
  }

  async #resolveMaterialization(workspaceId: string, assetId: string): Promise<AssetVersion> {
    const asset = this.index.get(workspaceId, assetId);
    if (asset.currentVersionId) {
      const version = this.index.version(workspaceId, assetId, asset.currentVersionId);
      await this.blobs.read(version.blobKey, version.sizeBytes);
      return version;
    }
    const key = `${workspaceId}:${assetId}`;
    const existing = this.#fetches.get(key);
    if (existing) return existing;
    if (this.#fetches.size >= this.limits.maxConcurrentFetches)
      throw new ResourceOperationError(429, "asset_fetch_capacity");
    const operation = this.#materialize(workspaceId, assetId).finally(() => this.#fetches.delete(key));
    this.#fetches.set(key, operation);
    return operation;
  }

  async #materialize(workspaceId: string, assetId: string): Promise<AssetVersion> {
    try {
      const source = this.index
        .sources(workspaceId, assetId)
        .find((source) => ["qq_group", "qq_private", "mount"].includes(source.kind));
      if (!source || !this.readSource) throw new ResourceOperationError(422, "asset_source_unsupported");
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), this.#shutdown.signal]);
      const bytes = await this.readSource(source, signal);
      const blob = await this.blobs.write(bytes, this.limits.maxRemoteFetchBytes, signal);
      return this.index.publish(workspaceId, assetId, blob);
    } catch (error) {
      const unavailable = error instanceof ResourceOperationError && [404, 410].includes(error.status);
      // 网络错误可能携带临时地址或令牌，只保存稳定错误码
      this.index.db
        .prepare("UPDATE assets SET fetch_state = ?, fetch_error = ? WHERE id = ? AND workspace_id = ?")
        .run(
          unavailable ? "remote-unavailable" : "fetch-failed",
          error instanceof ResourceOperationError ? error.code : "asset_fetch_failed",
          assetId,
          workspaceId
        );
      throw error instanceof ResourceOperationError ? error : new ResourceOperationError(502, "asset_fetch_failed");
    }
  }

  /** 接收附件时验证已落地内容，Run 使用中固定版本而非最新头 */
  async validate(workspaceId: string, attachments: readonly AssetAttachment[]): Promise<void> {
    if (attachments.length > 20) throw new ResourceOperationError(400, "too_many_attachments");
    for (const attachment of attachments) {
      const version = this.index.version(workspaceId, attachment.assetId, attachment.versionId);
      await this.blobs.read(version.blobKey, version.sizeBytes);
    }
  }

  /** 按可信 Run 上下文绑定版本，历史读取允许软删除资源但必须先有精确引用 */
  read(scope: AssetScope, assetId: string, versionId?: string) {
    return this.#track(() => this.#read(scope, assetId, versionId));
  }

  async #read(scope: AssetScope, assetId: string, versionId?: string) {
    const pinned = scope.runId
      ? (this.index.db
          .prepare(
            "SELECT version_id AS versionId FROM asset_refs WHERE workspace_id = ? AND asset_id = ? AND ref_type = 'run' AND ref_id = ? ORDER BY created_at, id LIMIT 1"
          )
          .get(scope.workspaceId, assetId, scope.runId) as { versionId: string } | undefined)
      : undefined;
    if (pinned && versionId && pinned.versionId !== versionId)
      throw new ResourceOperationError(409, "run_asset_version_conflict");
    const version = pinned
      ? this.index.version(scope.workspaceId, assetId, pinned.versionId, true)
      : versionId
        ? this.index.version(scope.workspaceId, assetId, versionId)
        : await this.materialize(scope.workspaceId, assetId);
    const bytes = await this.blobs.read(version.blobKey, version.sizeBytes);
    if (scope.runId && !pinned)
      this.index.reference({
        workspaceId: scope.workspaceId,
        assetId,
        versionId: version.id,
        refType: "run",
        refId: scope.runId
      });
    if (scope.taskId)
      this.index.reference({
        workspaceId: scope.workspaceId,
        assetId,
        versionId: version.id,
        refType: "task",
        refId: scope.taskId
      });
    return { version, bytes };
  }

  /** 停止接收异步资源操作，取消远端获取并等待写入收敛后再关闭数据库 */
  async drain(): Promise<void> {
    this.#shutdown.abort();
    await Promise.allSettled([...this.#operations]);
  }

  /** 宿主导入已核对来源的字节，不接受模型提供宿主路径或版本元数据 */
  saveContent(workspaceId: string, assetId: string, bytes: Uint8Array): Promise<AssetVersion> {
    return this.#track(async () => {
      this.index.get(workspaceId, assetId);
      const blob = await this.blobs.write(toStream(bytes), this.limits.maxRemoteFetchBytes, this.#shutdown.signal);
      return this.index.publish(workspaceId, assetId, blob);
    });
  }

  #track<T>(start: () => Promise<T>): Promise<T> {
    if (this.#shutdown.signal.aborted)
      return Promise.reject(new ResourceOperationError(503, "resource_service_closed"));
    const operation = start();
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation)
    );
    return operation;
  }
}

async function* toStream(bytes: Uint8Array) {
  yield bytes;
}
