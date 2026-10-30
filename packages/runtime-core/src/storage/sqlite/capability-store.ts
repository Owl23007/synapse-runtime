import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ResourceOperationError } from "../../assets/types.js";
import type { CapabilityInstall, WorkspaceCapability, RunDependencySnapshot } from "../../capabilities/types.js";

interface InstallRow extends Omit<CapabilityInstall, "source" | "metadata"> {
  sourceJson: string;
  metadataJson: string;
}
const columns = `id, kind, package_key AS packageKey, source_json AS sourceJson, source_version AS sourceVersion,
 source_revision AS sourceRevision, content_digest AS contentDigest, install_path AS installPath, metadata_json AS metadataJson, state, installed_at AS installedAt`;
function install(row: InstallRow): CapabilityInstall {
  const { sourceJson, metadataJson, ...value } = row;
  return { ...value, source: JSON.parse(sourceJson), metadata: JSON.parse(metadataJson) };
}

/** 能力持久化使用同一 Runtime 连接，授权切换与审计原子提交 */
export class SqliteCapabilityStore {
  /** 生命周期由上下文存储负责 */
  constructor(readonly db: Database.Database) {}

  /** 登记不可变快照，相同包与内容重复安装返回原记录 */
  save(input: Omit<CapabilityInstall, "id" | "installedAt" | "state">, actorId: string): CapabilityInstall {
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            `SELECT ${columns} FROM capability_installs WHERE package_key = ? AND content_digest = ? AND source_json = ?`
          )
          .get(input.packageKey, input.contentDigest, JSON.stringify(input.source)) as InstallRow | undefined;
        if (existing) return install(existing);
        const id = randomUUID();
        const time = new Date().toISOString();
        this.db
          .prepare("INSERT INTO capability_installs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?)")
          .run(
            id,
            input.kind,
            input.packageKey,
            JSON.stringify(input.source),
            input.sourceVersion,
            input.sourceRevision,
            input.contentDigest,
            input.installPath,
            JSON.stringify(input.metadata),
            time
          );
        this.audit(actorId, "install", input.packageKey, null, id, null, { digest: input.contentDigest });
        return this.get(id);
      })
      .immediate();
  }

  /** 管理端有界列出安装版本，可按类型与包身份检索 */
  list(kind?: string, query = ""): readonly CapabilityInstall[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM capability_installs WHERE (? IS NULL OR kind = ?) AND instr(lower(package_key), lower(?)) > 0 ORDER BY installed_at DESC, id LIMIT 500`
        )
        .all(kind ?? null, kind ?? null, query) as InstallRow[]
    ).map(install);
  }

  /** 不存在的安装项不能通过任意路径替代 */
  get(id: string): CapabilityInstall {
    const row = this.db.prepare(`SELECT ${columns} FROM capability_installs WHERE id = ?`).get(id) as
      | InstallRow
      | undefined;
    if (!row) throw new ResourceOperationError(404, "capability_not_found");
    return install(row);
  }

  /** 原子切换工作区版本，不删除旧快照或改写进行中的 Run */
  bind(
    workspaceId: string,
    packageKey: string,
    input: { installId: string; enabled: boolean; settings?: Readonly<Record<string, unknown>> },
    actorId: string
  ): WorkspaceCapability {
    return this.db
      .transaction(() => {
        if (!this.db.prepare("SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL").get(workspaceId))
          throw new ResourceOperationError(404, "workspace_not_found");
        const capability = this.get(input.installId);
        if (capability.packageKey !== packageKey || (input.enabled && capability.state !== "installed"))
          throw new ResourceOperationError(409, "capability_not_installed");
        const previous = this.bindings(workspaceId).find((binding) => binding.packageKey === packageKey);
        const settings = JSON.stringify(input.settings ?? {});
        if (
          settings.length > 16000 ||
          /"[^"\\]*(token|password|secret|apiKey|authorization)[^"\\]*"\s*:/i.test(settings)
        )
          throw new ResourceOperationError(400, "secrets_must_use_config_references");
        this.db
          .prepare(
            `INSERT INTO workspace_capabilities VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, package_key) DO UPDATE SET install_id = excluded.install_id, enabled = excluded.enabled, settings_json = excluded.settings_json, updated_at = excluded.updated_at`
          )
          .run(workspaceId, packageKey, input.installId, input.enabled ? 1 : 0, settings, new Date().toISOString());
        this.audit(
          actorId,
          input.enabled ? "enable_or_switch" : "disable",
          packageKey,
          previous?.installId ?? null,
          input.installId,
          workspaceId,
          {}
        );
        return this.bindings(workspaceId).find((binding) => binding.packageKey === packageKey)!;
      })
      .immediate();
  }

  /** 工作区授权列表，不依赖 WebUI 隐藏来隔离能力 */
  bindings(workspaceId: string): readonly WorkspaceCapability[] {
    return (
      this.db
        .prepare(
          "SELECT workspace_id AS workspaceId, package_key AS packageKey, install_id AS installId, enabled, settings_json AS settingsJson, updated_at AS updatedAt FROM workspace_capabilities WHERE workspace_id = ? ORDER BY package_key"
        )
        .all(workspaceId) as (Omit<WorkspaceCapability, "settings" | "enabled"> & {
        settingsJson: string;
        enabled: number;
      })[]
    ).map(({ settingsJson, enabled, ...row }) => ({
      ...row,
      enabled: enabled === 1,
      settings: JSON.parse(settingsJson)
    }));
  }

  /** 正在执行的 Run 可继续读旧版本，但工作区停用会立即撤销使用权 */
  canUse(workspaceId: string | undefined, installId: string, runId?: string): boolean {
    if (!workspaceId) return false;
    const capability = this.get(installId);
    if (capability.state !== "installed") return false;
    const binding = this.bindings(workspaceId).find(
      (binding) => binding.packageKey === capability.packageKey && binding.enabled
    );
    const pinned = runId ? this.snapshot(runId) : undefined;
    if (pinned)
      return (
        pinned.workspaceId === workspaceId &&
        !!binding &&
        !!this.db.prepare("SELECT 1 FROM run_capabilities WHERE run_id = ? AND install_id = ?").get(runId, installId)
      );
    return !!binding && binding.installId === installId;
  }

  /** 接受运行时一次性固定安装版本，后续升级不会改写快照 */
  pin(runId: string, snapshot: RunDependencySnapshot, installIds: readonly string[]): RunDependencySnapshot {
    return this.db
      .transaction(() => {
        const existing = this.snapshot(runId);
        if (existing) {
          if (existing.workspaceId !== snapshot.workspaceId)
            throw new ResourceOperationError(409, "run_workspace_conflict");
          return existing;
        }
        this.db
          .prepare("INSERT INTO run_dependencies VALUES (?, ?, ?, ?)")
          .run(runId, snapshot.workspaceId, JSON.stringify(snapshot), new Date().toISOString());
        for (const id of installIds) this.db.prepare("INSERT INTO run_capabilities VALUES (?, ?)").run(runId, id);
        return snapshot;
      })
      .immediate();
  }

  /** 运行依赖读取只返回保存的事实，不进行远端发现 */
  snapshot(runId: string): RunDependencySnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot_json AS json FROM run_dependencies WHERE run_id = ?").get(runId) as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  /** 安装版本保留审计，无法确定副作用时不会自动重放 */
  audit(
    actorId: string,
    action: string,
    packageKey: string,
    from: string | null,
    to: string | null,
    workspaceId: string | null,
    details: unknown
  ): void {
    this.db
      .prepare("INSERT INTO capability_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        randomUUID(),
        actorId,
        action,
        workspaceId,
        packageKey,
        from,
        to,
        JSON.stringify(details),
        new Date().toISOString()
      );
  }
}
