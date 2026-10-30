/** Runtime 保存的能力快照，Secrets 只允许使用引用 */
export interface CapabilityInstall {
  readonly id: string;
  readonly kind: "skill" | "mcp";
  readonly packageKey: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly sourceVersion: string | null;
  readonly sourceRevision: string | null;
  readonly contentDigest: string;
  readonly installPath: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly state: "installed" | "disabled" | "failed";
  readonly installedAt: string;
}

/** Workspace 指向特定已安装版本，设置不能包含凭据 */
export interface WorkspaceCapability {
  readonly workspaceId: string;
  readonly packageKey: string;
  readonly installId: string;
  readonly enabled: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

/** 运行接受时固定的能力与工具摘要，远程 MCP 只记录观察事实 */
export interface RunDependencySnapshot {
  readonly workspaceId: string;
  readonly assets: readonly { assetId: string; versionId: string; sha256: string }[];
  readonly skills: readonly { installId: string; contentDigest: string }[];
  readonly toolSetDigest: string;
  readonly skillSetDigest: string;
  readonly mcpConnections: readonly {
    id: string;
    installId: string;
    configDigest: string;
    observedToolSetDigest?: string;
  }[];
}
