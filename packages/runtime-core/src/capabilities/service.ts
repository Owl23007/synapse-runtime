import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, lstat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  SkillDirectoryLoader,
  parseClawHubId,
  extractSkillArchive,
  validateSkillPath,
  type CatalogProvider,
  type DirectorySkill
} from "@synapse/runtime-resources";
import type { SqliteCapabilityStore } from "../storage/sqlite/capability-store.js";
import { ResourceOperationError } from "../assets/types.js";
import type { CapabilityInstall } from "./types.js";

/** 安装请求只接受来源身份和精确版本，不接受可执行命令或任意下载 URL */
export const CapabilityInstallInputSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("clawhub"),
      packageId: z.string().regex(/^(?:[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9-]{0,100}$/),
      version: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => !["latest", "main", "master"].includes(value)),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
    })
    .strict(),
  z
    .object({
      provider: z.literal("github"),
      packageId: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      directory: z.string().max(400).optional()
    })
    .strict(),
  z
    .object({
      provider: z.literal("mcp-official"),
      packageId: z.string().min(1).max(300),
      version: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => value !== "latest"),
      endpointIndex: z.number().int().min(0).max(19).default(0)
    })
    .strict()
]);

/** 能力用例只协调快照、目录与授权，不启动 Skill 脚本 */
export class CapabilityService {
  readonly #root: string;
  readonly #loaders = new Map<string, SkillDirectoryLoader>();
  readonly #updates = new Map<string, unknown>();
  #installing = 0;
  /** 网络与配置由应用注入，领域层不读取进程环境变量 */
  constructor(
    readonly store: SqliteCapabilityStore,
    directory: string,
    readonly catalogs: readonly CatalogProvider[],
    readonly fetch: typeof globalThis.fetch,
    readonly allowedSources: readonly string[],
    readonly allowedMcpHosts: readonly string[] = []
  ) {
    this.#root = resolve(directory);
  }

  /** 搜索目录不会安装、下载包或更改工作区授权 */
  catalog(id: string): CatalogProvider {
    const catalog = this.catalogs.find((item) => item.id === id);
    if (!catalog) throw new ResourceOperationError(404, "catalog_not_found");
    return catalog;
  }

  /** 安装来源精确锁定，离线执行依赖本地快照而非商店在线状态 */
  async install(value: unknown, actorId: string): Promise<CapabilityInstall> {
    const input = CapabilityInstallInputSchema.parse(value);
    if (!this.allowedSources.includes(input.provider))
      throw new ResourceOperationError(403, "capability_source_not_allowed");
    if (this.#installing >= 2) throw new ResourceOperationError(429, "capability_install_capacity");
    this.#installing++;
    try {
      if (input.provider === "mcp-official") {
        const metadata = await this.catalog("mcp-official").get(input.packageId, input.version);
        const endpoint = metadata.remotes?.filter((remote) => remote.type === "streamable-http")[input.endpointIndex];
        if (!endpoint) throw new ResourceOperationError(422, "remote_http_endpoint_required");
        const url = new URL(endpoint.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !this.allowedMcpHosts.includes(url.hostname)
        )
          throw new ResourceOperationError(403, "mcp_host_requires_configuration");
        const source = {
          provider: input.provider,
          packageId: input.packageId,
          registryVersion: input.version,
          url: url.href,
          transport: "streamable-http"
        };
        return this.store.save(
          {
            kind: "mcp",
            packageKey: `mcp-official:${input.packageId}`,
            source,
            sourceVersion: input.version,
            sourceRevision: null,
            contentDigest: digest(JSON.stringify(source)),
            installPath: null,
            metadata: { ...metadata, reproducibility: "observed" }
          },
          actorId
        );
      }
      if (input.provider === "github" && input.directory) validateSkillPath(input.directory);
      const registryMetadata =
        input.provider === "clawhub" ? await this.catalog("clawhub").get(input.packageId, input.version) : undefined;
      if (registryMetadata?.moderation?.isMalwareBlocked)
        throw new ResourceOperationError(403, "capability_blocked_by_source");
      const clawIdentity = input.provider === "clawhub" ? parseClawHubId(input.packageId) : undefined;
      const url =
        input.provider === "clawhub"
          ? `https://clawhub.ai/api/v1/download?${new URLSearchParams({ slug: clawIdentity!.slug, version: input.version, ...(clawIdentity!.owner ? { ownerHandle: clawIdentity!.owner } : {}) })}`
          : `https://codeload.github.com/${input.packageId}/zip/${input.revision}`;
      let response = await this.fetch(url);
      if (!response.ok) throw new ResourceOperationError(502, "capability_download_failed");
      let archiveOptions: { stripRoot?: boolean; subdirectory?: string } =
        input.provider === "github"
          ? { stripRoot: true, ...(input.directory ? { subdirectory: input.directory } : {}) }
          : {};
      let handoff: { repo: string; commit: string; path: string; contentHash: string } | undefined;
      if (input.provider === "clawhub" && response.headers.get("content-type")?.includes("application/json")) {
        if (!this.allowedSources.includes("github"))
          throw new ResourceOperationError(403, "github_handoff_not_allowed");
        const descriptor = z
          .object({
            sourceRef: z.literal("public-github"),
            repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            commit: z.string().regex(/^[a-f0-9]{40}$/),
            path: z.string().max(400),
            contentHash: z.string().min(1).max(128)
          })
          .parse(await response.json());
        const path = descriptor.path === "." ? "" : descriptor.path;
        if (path) validateSkillPath(path);
        // handoff 自带的 archiveUrl 不作为信任依据，只从已验证的仓库和 commit 构造下载地址
        response = await this.fetch(`https://codeload.github.com/${descriptor.repo}/zip/${descriptor.commit}`);
        if (!response.ok) throw new ResourceOperationError(502, "github_handoff_download_failed");
        handoff = { repo: descriptor.repo, commit: descriptor.commit, path, contentHash: descriptor.contentHash };
        archiveOptions = { stripRoot: true, ...(path ? { subdirectory: path } : {}) };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (input.provider === "clawhub" && input.expectedSha256 && digest(bytes) !== input.expectedSha256)
        throw new ResourceOperationError(409, "capability_download_digest_mismatch");
      await this.#prepareRoot();
      const stage = join(this.#root, "staging", randomUUID());
      await mkdir(stage, { mode: 0o700 });
      try {
        await extractSkillArchive(bytes, stage, archiveOptions);
        const loader = new SkillDirectoryLoader(stage);
        const snapshotPath = join(this.#root, "snapshots", loader.skill.contentDigest);
        try {
          await lstat(snapshotPath);
          if (new SkillDirectoryLoader(snapshotPath).skill.contentDigest !== loader.skill.contentDigest)
            throw new Error("Snapshot digest mismatch");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await rename(stage, snapshotPath);
        }
        return this.store.save(
          {
            kind: "skill",
            packageKey: `${input.provider}:${registryMetadata?.packageId ?? input.packageId}${input.provider === "github" && input.directory ? `#${input.directory}` : ""}`,
            source: {
              ...input,
              packageId: registryMetadata?.packageId ?? input.packageId,
              archiveSha256: digest(bytes),
              ...(handoff ? { handoff } : {})
            },
            sourceVersion: input.provider === "clawhub" ? input.version : null,
            sourceRevision: input.provider === "github" ? input.revision : (handoff?.commit ?? null),
            contentDigest: loader.skill.contentDigest,
            installPath: snapshotPath,
            metadata: { ...this.#metadata(loader.skill), ...(registryMetadata ? { registry: registryMetadata } : {}) }
          },
          actorId
        );
      } finally {
        await this.#removeStage(stage);
      }
    } finally {
      this.#installing--;
    }
  }

  /** 本地目录导入仅供管理员宿主装配使用，HTTP 不暴露任意宿主路径入口 */
  registerDirectory(directory: string, packageKey: string, actorId: string): CapabilityInstall {
    const loader = new SkillDirectoryLoader(directory);
    return this.store.save(
      {
        kind: "skill",
        packageKey,
        source: { provider: "runtime" },
        sourceVersion: null,
        sourceRevision: null,
        contentDigest: loader.skill.contentDigest,
        installPath: resolve(directory),
        metadata: this.#metadata(loader.skill)
      },
      actorId
    );
  }

  /** 工作区启用版本或回滚，只改指针并保留旧快照 */
  bind(workspaceId: string, packageKey: string, value: unknown, actorId: string) {
    const input = z
      .object({
        installId: z.string().min(1),
        enabled: z.boolean(),
        settings: z.record(z.string(), z.unknown()).default({})
      })
      .strict()
      .parse(value);
    return this.store.bind(workspaceId, packageKey, input, actorId);
  }

  /** 列出当前工作区安装视图，Run 已固定时使用快照内版本 */
  enabled(workspaceId: string, runId?: string): readonly CapabilityInstall[] {
    const snapshot = runId ? this.store.snapshot(runId) : undefined;
    const ids = snapshot
      ? [
          ...snapshot.skills.map((skill) => skill.installId),
          ...snapshot.mcpConnections.map((connection) => connection.installId)
        ]
      : this.store
          .bindings(workspaceId)
          .filter((binding) => binding.enabled)
          .map((binding) => binding.installId);
    return ids.filter((id) => this.store.canUse(workspaceId, id, runId)).map((id) => this.store.get(id));
  }

  /** 每次读取重新验证安装摘要，外部 Skill 永不授予额外工具权限 */
  loader(installId: string): SkillDirectoryLoader {
    const installation = this.store.get(installId);
    if (installation.kind !== "skill" || !installation.installPath || installation.state !== "installed")
      throw new ResourceOperationError(409, "skill_not_installed");
    const loader = this.#loaders.get(installId) ?? new SkillDirectoryLoader(installation.installPath);
    if (loader.skill.contentDigest !== installation.contentDigest)
      throw new ResourceOperationError(409, "skill_snapshot_integrity_failure");
    this.#loaders.set(installId, loader);
    return loader;
  }

  /** 检查来源更新只记录发现结果，不改变任何绑定 */
  async checkUpdates(installId: string): Promise<unknown> {
    const installation = this.store.get(installId);
    const provider = installation.source.provider;
    let result: unknown;
    if (provider === "clawhub" || provider === "mcp-official") {
      const entry = await this.catalog(provider).get(String(installation.source.packageId));
      result = {
        installId,
        checkedAt: new Date().toISOString(),
        currentVersion: installation.sourceVersion,
        latestVersion: entry.version ?? null,
        available: !!entry.version && entry.version !== installation.sourceVersion
      };
    } else if (provider === "github") {
      const response = await this.fetch(
        `https://api.github.com/repos/${String(installation.source.packageId)}/commits?per_page=1`,
        { headers: { accept: "application/vnd.github+json", "user-agent": "synapse-runtime" } }
      );
      if (!response.ok) throw new ResourceOperationError(502, "github_update_check_failed");
      const latest = z
        .array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }))
        .parse(await response.json())[0]?.sha;
      result = {
        installId,
        checkedAt: new Date().toISOString(),
        currentRevision: installation.sourceRevision,
        latestRevision: latest ?? null,
        available: !!latest && latest !== installation.sourceRevision
      };
    } else result = { installId, available: false, reason: "runtime_managed" };
    this.#updates.set(installId, result);
    return result;
  }

  /** 管理页面读取上次检查结果，不隐式访问远端 */
  updates(): readonly unknown[] {
    return [...this.#updates.values()];
  }

  #metadata(skill: DirectorySkill) {
    return {
      name: skill.name,
      description: skill.description,
      license: skill.license ?? null,
      compatibility: skill.compatibility ?? null,
      files: skill.files,
      scripts: skill.files.filter((file) => file.path.startsWith("scripts/")).map((file) => file.path),
      execution: "instructions-only"
    };
  }
  async #prepareRoot() {
    for (const path of [this.#root, join(this.#root, "staging"), join(this.#root, "snapshots")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if ((await lstat(path)).isSymbolicLink()) throw new ResourceOperationError(409, "unsafe_capability_storage");
    }
  }
  async #removeStage(path: string) {
    if (!resolve(path).startsWith(join(this.#root, "staging") + sep)) throw new Error("Invalid stage path");
    await rm(path, { recursive: true, force: true });
  }
}

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
