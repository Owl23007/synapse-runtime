/** 持久资源的真实来源，定位字段不得包含临时下载地址或凭据 */
export type AssetSourceKind = "qq_group" | "qq_private" | "native" | "artifact" | "mount";

/** 资源元数据列表项，列表读取不会物化远端内容 */
export interface Asset {
  readonly id: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly declaredMime: string | null;
  readonly declaredSizeBytes: number | null;
  readonly currentVersionId: string | null;
  readonly fetchState: "fetch-failed" | "remote-unavailable" | null;
  readonly fetchError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** 只有实际保存并校验过的内容才能成为不可变版本 */
export interface AssetVersion {
  readonly id: string;
  readonly assetId: string;
  readonly versionNo: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly blobKey: string;
  readonly createdAt: string;
}

/** 稳定来源与首次、最近发现时间，重复通知仅推进最近发现时间 */
export interface AssetSource {
  readonly id: string;
  readonly workspaceId: string;
  readonly assetId: string;
  readonly kind: AssetSourceKind;
  readonly sourceKey: string;
  readonly locator: Readonly<Record<string, string>>;
  readonly observedAt: string;
  readonly lastSeenAt: string;
}

/** 内容使用关系，Run 和 Task 必须携带确定版本 */
export interface AssetReference {
  readonly id: string;
  readonly workspaceId: string;
  readonly assetId: string;
  readonly versionId: string | null;
  readonly refType: "message" | "run" | "task" | "artifact";
  readonly refId: string;
  readonly createdAt: string;
}

/** 从可信运行上下文取得的资源作用域，不能由模型指定 */
export interface AssetScope {
  readonly workspaceId: string;
  readonly runId?: string;
  readonly taskId?: string;
}

/** 资源领域错误，传输层按状态码映射且不暴露宿主路径 */
export class ResourceOperationError extends Error {
  /** 保留业务状态供 HTTP 与工具边界使用 */
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

/** 受授权的不可变内容引用 */
export interface AssetAttachment {
  readonly assetId: string;
  readonly versionId: string;
}

/** 列表使用稳定复合游标，限制单次元数据开销 */
export interface AssetQuery {
  readonly query?: string | undefined;
  readonly source?: AssetSourceKind;
  readonly cursor?: string;
  readonly limit?: number;
}

/** 管理与工具共享的资源索引端口 */
export interface AssetIndex {
  /** 只查询当前工作区的未删除资源 */
  list(workspaceId: string, query?: AssetQuery): { items: readonly Asset[]; nextCursor?: string };
  /** 资源不存在或不属于作用域时统一拒绝 */
  get(workspaceId: string, assetId: string, includeDeleted?: boolean): Asset;
  /** 获取确定资源版本，不能把版本 ID 当作授权凭证 */
  version(workspaceId: string, assetId: string, versionId: string, includeDeleted?: boolean): AssetVersion;
  /** 幂等索引稳定来源，不创建内容版本 */
  observe(input: {
    workspaceId: string;
    name: string;
    kind: AssetSourceKind;
    locator: Readonly<Record<string, string>>;
    observedAt?: string;
    mime?: string;
    size?: number;
  }): Asset;
  /** 读取资源的稳定来源 */
  sources(workspaceId: string, assetId: string): readonly AssetSource[];
  /** 记录精确内容或非内容来源关系 */
  reference(input: Omit<AssetReference, "id" | "createdAt">): AssetReference;
}
