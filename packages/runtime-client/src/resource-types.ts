/** 持久工作区资源域，与 Native 会话工作台独立 */
export interface ResourceWorkspace {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** 文件列表只包含元数据，不隐式下载内容 */
export interface AssetInfo {
  readonly id: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly declaredMime: string | null;
  readonly declaredSizeBytes: number | null;
  readonly currentVersionId: string | null;
  readonly fetchState: string | null;
  readonly fetchError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** 不可变文件内容版本 */
export interface AssetVersionInfo {
  readonly id: string;
  readonly assetId: string;
  readonly versionNo: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly createdAt: string;
}

/** 文件来源、版本及运行关系，不包含临时下载 URL */
export interface AssetDetail {
  readonly asset: AssetInfo;
  readonly sources: readonly {
    id: string;
    kind: string;
    locator: Readonly<Record<string, string>>;
    observedAt: string;
    lastSeenAt: string;
  }[];
  readonly versions: readonly AssetVersionInfo[];
  readonly refs: readonly { refType: string; refId: string; versionId: string | null; createdAt: string }[];
}

/** 会话附件固定内容版本而不是最新文件头 */
export interface AssetAttachmentInfo {
  readonly assetId: string;
  readonly versionId: string;
  readonly name: string;
}

/** 安装快照公开描述不包含宿主路径或凭据 */
export interface CapabilityInfo {
  readonly id: string;
  readonly kind: "skill" | "mcp";
  readonly packageKey: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly sourceVersion: string | null;
  readonly sourceRevision: string | null;
  readonly contentDigest: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly state: string;
  readonly installedAt: string;
}

/** 工作区启用的确定能力版本 */
export interface CapabilityBinding {
  readonly workspaceId: string;
  readonly packageKey: string;
  readonly installId: string;
  readonly enabled: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** 第三方目录发现结果，元数据不代表安全认证 */
export interface CatalogItem {
  readonly provider: "clawhub" | "mcp-official";
  readonly packageId: string;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly author?: string;
  readonly license?: string;
  readonly url?: string;
  readonly remotes?: readonly { type: string; url: string }[];
}

/** 远程连接状态与实际协商结果 */
export interface McpConnectionInfo {
  readonly permissionAction?: string;
  readonly id: string;
  readonly installId: string;
  readonly packageKey: string;
  readonly state: string;
  readonly error?: string;
  readonly protocolVersion?: string;
  readonly serverVersion?: { name: string; version: string };
  readonly observedToolSetDigest?: string;
  readonly tools: readonly { name: string; description?: string; inputSchema: Readonly<Record<string, unknown>> }[];
}
