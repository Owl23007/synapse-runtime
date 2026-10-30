import { createHash } from "node:crypto";
import {
  CapabilityService,
  type CapabilityInstall,
  type RunDependencySnapshot
} from "@synapse/runtime-core/capabilities";
import type { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { ResourceOperationError } from "@synapse/runtime-core/assets";
import {
  CatalogHttp,
  ClawHubCatalog,
  McpRegistryCatalog,
  type InvocationCompileInput
} from "@synapse/runtime-resources";
import { createSafeFetch } from "@synapse/runtime-tool-web";
import { RemoteMcpConnection } from "@synapse/runtime-tool-mcp";
import { McpServerSettingsSchema } from "@synapse/runtime-tool-mcp/config";
import type { AgentRequest, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import { describeToolSet, type ToolRuntime, type Tool } from "@synapse/runtime-tool-runtime";
import { z } from "zod";
import type { RuntimeConfig } from "../config/index.js";

/** 能力装配持有网络连接与更新任务，领域服务只管理安装和授权 */
export class CapabilityResources {
  readonly service: CapabilityService;
  readonly #connections = new Map<string, RemoteMcpConnection>();
  readonly #registered = new Set<string>();
  readonly #connectionErrors = new Map<string, string>();
  readonly #shutdown = new AbortController();
  readonly #config: RuntimeConfig;
  readonly #context: SqliteRuntimeContextStore;
  readonly #tools: ToolRuntime;
  readonly #removeObserver: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #updating: Promise<void> | undefined;
  #closed = false;
  /** 所有外部网络通过受控 HTTP，凭据引用在宿主边界解析 */
  constructor(config: RuntimeConfig, context: SqliteRuntimeContextStore, tools: ToolRuntime) {
    this.#config = config;
    this.#context = context;
    this.#tools = tools;
    const safeFetch = createSafeFetch({
      maxBytes: 20 * 1024 * 1024
    });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      return safeFetch(request, { signal: AbortSignal.any([request.signal, this.#shutdown.signal]) });
    };
    const http = new CatalogHttp(fetch);
    const enabledCatalogs = new Set(
      config.capabilities.catalogs.filter((catalog) => catalog.enabled).map((catalog) => catalog.id)
    );
    this.service = new CapabilityService(
      context.capabilities,
      config.capabilities.skillsDirectory,
      [new ClawHubCatalog(http), new McpRegistryCatalog(http)].filter((catalog) =>
        enabledCatalogs.has(catalog.id as "clawhub" | "mcp-official")
      ),
      fetch,
      config.capabilities.allowedSources,
      config.mcp.allowedHosts
    );
    for (const server of config.mcp.servers) {
      const source = { provider: "runtime", ...server };
      const contentDigest = hash(JSON.stringify(source));
      context.capabilities.save(
        {
          kind: "mcp",
          packageKey: `runtime:mcp:${server.id}`,
          source,
          sourceVersion: null,
          sourceRevision: null,
          contentDigest,
          installPath: null,
          metadata: { name: server.id, reproducibility: "observed", transport: "streamable-http" }
        },
        "runtime"
      );
    }
    for (const tool of this.#skillTools()) tools.register(tool);
    this.#removeObserver = tools.addObserver((event) => {
      if (event.type !== "tool_call_succeeded" || !context.runs.get(event.context.runId)) return;
      if (event.name === "asset.read") {
        const result = event.output as { assetId?: string; version?: { id: string; sha256: string } };
        if (result.version && result.assetId)
          context.runs.append(event.context.runId, {
            key: `asset:${result.assetId}:${result.version.id}`,
            type: "asset_materialized",
            data: {
              workspaceId: event.context.workspaceId,
              assetId: result.assetId,
              versionId: result.version.id,
              sha256: result.version.sha256
            }
          });
      }
      if (event.name === "skill.read") {
        const value = event.output as { installId: string; contentDigest: string };
        context.runs.append(event.context.runId, {
          key: `skill:${value.installId}`,
          type: "skill_activated",
          data: value
        });
      }
    });
    if (config.capabilities.autoCheckUpdates) this.#scheduleUpdates();
  }

  /** 运行编译前发现已授权远程工具，失败留在 Connections 页面且不伪造可用能力 */
  async prepare(request: AgentRequest): Promise<void> {
    if (!request.workspaceId || this.#closed) return;
    for (const install of this.service
      .enabled(request.workspaceId, request.runId)
      .filter((item) => item.kind === "mcp")) {
      try {
        await this.connect(install.id);
      } catch {
        /* 连接失败不阻止其他文件或 Skill 能力 */
      }
    }
  }

  /** 安装项决定不可变连接配置，模型或浏览器不能提交启动命令 */
  async connect(installId: string) {
    try {
      const status = await this.#connect(installId);
      this.#connectionErrors.delete(installId);
      return status;
    } catch (error) {
      this.#connectionErrors.set(
        installId,
        error instanceof ResourceOperationError ? error.code : "mcp_connection_failed"
      );
      throw error;
    }
  }

  async #connect(installId: string) {
    if (this.#closed) throw new ResourceOperationError(503, "runtime_closed");
    const install = this.service.store.get(installId);
    if (
      install.source.provider === "runtime" &&
      !this.#config.mcp.servers.some((server) => server.id === install.source.id && server.enabled)
    )
      throw new ResourceOperationError(409, "mcp_config_disabled");
    if (install.kind !== "mcp") throw new ResourceOperationError(400, "mcp_install_required");
    if (install.source.enabled === false) throw new ResourceOperationError(409, "mcp_config_disabled");
    let connection = this.#connections.get(installId);
    if (!connection) {
      const logicalId =
        typeof install.source.id === "string" ? install.source.id : `registry-${hash(install.packageKey).slice(0, 12)}`;
      const id = `${logicalId.slice(0, 48)}-${install.contentDigest.slice(0, 8)}`;
      const server = McpServerSettingsSchema.parse({
        id,
        transport: "streamable-http",
        url: install.source.url,
        enabled: true,
        ...(install.source.authTokenEnv ? { authTokenEnv: install.source.authTokenEnv } : {})
      });
      const host = new URL(server.url).hostname;
      if (!this.#config.mcp.allowedHosts.includes(host))
        throw new ResourceOperationError(403, "mcp_host_requires_configuration");
      const token = server.authTokenEnv ? process.env[server.authTokenEnv] : undefined;
      if (server.authTokenEnv && !token) throw new ResourceOperationError(409, "mcp_auth_environment_missing");
      const safeFetch = createSafeFetch({
        allowedHosts: [host],
        privateHosts: this.#config.mcp.privateHosts,
        timeoutMs: this.#config.mcp.timeoutMs,
        maxBytes: this.#config.mcp.maxResponseBytes
      });
      connection = new RemoteMcpConnection(server, {
        permissionAction: `mcp.${logicalId}.call`,
        timeoutMs: this.#config.mcp.timeoutMs,
        token,
        fetch: (input, init) => {
          const request = new Request(input, init);
          return safeFetch(request, { signal: AbortSignal.any([request.signal, this.#shutdown.signal]) });
        },
        policy: {
          allowedHosts: [host],
          privateHosts: this.#config.mcp.privateHosts,
          timeoutMs: this.#config.mcp.timeoutMs,
          maxBytes: this.#config.mcp.maxResponseBytes
        },
        available: (scope) => {
          if (this.#closed) return false;
          if (!this.service.store.canUse(scope.workspaceId, installId, scope.runId)) return false;
          const expected = scope.runId
            ? this.service.store.snapshot(scope.runId)?.mcpConnections.find((item) => item.installId === installId)
                ?.observedToolSetDigest
            : undefined;
          return !expected || expected === this.#connections.get(installId)?.status.observedToolSetDigest;
        }
      });
      this.#connections.set(installId, connection);
    }
    const tools = await connection.connect();
    if (this.#closed) throw new ResourceOperationError(503, "runtime_closed");
    for (const tool of tools) {
      if (this.#registered.has(tool.name)) this.#tools.replace(tool);
      else {
        this.#tools.register(tool);
        this.#registered.add(tool.name);
      }
    }
    return connection.status;
  }

  /** 显式刷新连接后更新工具描述，旧 Run 的工具摘要仍可核对 */
  async refresh(installId: string) {
    const previous = this.#connections.get(installId);
    if (previous) await previous.close();
    this.#connections.delete(installId);
    const status = await this.connect(installId);
    for (const tool of await this.#connections.get(installId)!.connect()) this.#tools.replace(tool);
    return status;
  }

  /** 状态查询不会启动或重新连接服务 */
  connections() {
    return this.service.store.list("mcp").map((install) => ({
      installId: install.id,
      packageKey: install.packageKey,
      ...(this.#connections.get(install.id)?.status ?? {
        id: install.id,
        state: this.#connectionErrors.has(install.id) ? "failed" : "disconnected",
        tools: [],
        ...(this.#connectionErrors.has(install.id) ? { error: this.#connectionErrors.get(install.id) } : {})
      })
    }));
  }

  /** 标准 Skill 目录只发布元数据，显式激活时由安全加载器读取正文 */
  directorySkills(
    request: AgentRequest,
    visibleTools?: readonly string[]
  ): NonNullable<InvocationCompileInput["directorySkills"]> {
    if (!request.workspaceId || this.#closed) return [];
    return this.service
      .enabled(request.workspaceId, request.runId)
      .filter((install) => install.kind === "skill")
      .map((install) => {
        if (request.requestedSkillIds?.includes(install.id)) {
          const required = this.service.store
            .bindings(request.workspaceId!)
            .find((binding) => binding.packageKey === install.packageKey)?.settings.requiredTools;
          if (
            Array.isArray(required) &&
            required.some((name) => typeof name !== "string" || !visibleTools?.includes(name))
          )
            throw new ResourceOperationError(409, "skill_required_tool_missing");
        }
        const skill = this.service.loader(install.id).skill;
        return {
          id: install.id,
          version: install.contentDigest,
          description: skill.description,
          contentDigest: install.contentDigest,
          ...(request.requestedSkillIds?.includes(install.id) ? { instructions: this.#instructions(install) } : {})
        };
      });
  }

  /** 复用 PromptBundleCompiler 已生成的摘要，不计算另一套 Skill 或 Tool digest */
  pin(request: AgentRequest, invocation?: ModelInvocationEnvelope): RunDependencySnapshot | undefined {
    if (!request.runId || !request.workspaceId || this.#closed) return undefined;
    const previousSnapshot = this.service.store.snapshot(request.runId);
    if (previousSnapshot) return previousSnapshot;
    const enabled = this.service.enabled(request.workspaceId, request.runId);
    const refs = this.#context.assets.db
      .prepare(
        "SELECT r.asset_id AS assetId, r.version_id AS versionId, v.sha256 FROM asset_refs r JOIN asset_versions v ON v.id = r.version_id WHERE r.workspace_id = ? AND r.ref_type = 'run' AND r.ref_id = ?"
      )
      .all(request.workspaceId, request.runId) as RunDependencySnapshot["assets"];
    const snapshot: RunDependencySnapshot = {
      workspaceId: request.workspaceId,
      assets: refs,
      skills: enabled
        .filter((install) => install.kind === "skill")
        .map((install) => ({ installId: install.id, contentDigest: install.contentDigest })),
      toolSetDigest:
        invocation?.capabilities.toolSetDigest ??
        describeToolSet(
          this.#tools.listForContext({
            workspaceId: request.workspaceId,
            runId: request.runId,
            sessionId: request.sessionId,
            userId: request.userId
          })
        ).digest,
      skillSetDigest: invocation?.capabilities.skillSetDigest ?? "",
      mcpConnections: enabled
        .filter((install) => install.kind === "mcp")
        .map((install) => ({
          id: this.#connections.get(install.id)?.config.id ?? install.id,
          installId: install.id,
          configDigest: install.contentDigest,
          ...(this.#connections.get(install.id)?.status.observedToolSetDigest
            ? { observedToolSetDigest: this.#connections.get(install.id)!.status.observedToolSetDigest! }
            : {})
        }))
    };
    const pinned = this.service.store.pin(
      request.runId,
      snapshot,
      enabled.map((install) => install.id)
    );
    this.#context.runs.append(request.runId, {
      key: "dependency_snapshot",
      type: "dependencies_resolved",
      data: pinned
    });
    return pinned;
  }

  /** 关闭前等待后台更新及连接清理，避免晚到写入访问已关闭数据库 */
  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort();
    clearTimeout(this.#timer);
    this.#removeObserver();
    await this.#updating;
    await Promise.allSettled([...this.#connections.values()].map((connection) => connection.close()));
  }

  #instructions(install: CapabilityInstall): string {
    this.service.loader(install.id).readResource("SKILL.md", 0, 32000);
    return this.service.loader(install.id).skill.instructions;
  }
  #skillTools(): readonly Tool[] {
    const schema = z
      .object({
        installId: z.string().min(1),
        path: z.string().max(500).optional(),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(16000).default(8000)
      })
      .strict();
    return ["skill.read", "skill.read_resource"].map((name) => ({
      name,
      description:
        name === "skill.read"
          ? "按 installId 加载本工作区已启用 Skill 的说明；不会执行脚本或授予新权限"
          : "按 installId 和相对路径分页读取 Skill 快照内的辅助资料，禁止宿主路径",
      inputSchema: z.toJSONSchema(schema),
      permission: { action: "skill.read", resource: "workspace:skills" },
      available: (context) => !this.#closed && !!context.workspaceId,
      handle: async (input, context) => {
        const value = schema.parse(input);
        if (!this.service.store.canUse(context.workspaceId, value.installId, context.runId))
          throw new ResourceOperationError(404, "skill_not_enabled");
        const installation = this.service.store.get(value.installId);
        const loader = this.service.loader(value.installId);
        const binding = this.service.store
          .bindings(context.workspaceId!)
          .find((item) => item.packageKey === installation.packageKey);
        const required = binding?.settings.requiredTools;
        if (Array.isArray(required)) {
          const available = this.#tools.listForContext(context);
          for (const name of required) {
            const tool = typeof name === "string" ? available.find((tool) => tool.name === name) : undefined;
            if (!tool) throw new ResourceOperationError(409, "skill_required_tool_missing");
            if (typeof tool.permission !== "function") {
              const decision = await this.#tools.decidePermission({ ...tool.permission, subject: context.userId });
              if (decision.decision !== "allow") throw new ResourceOperationError(409, "skill_required_tool_blocked");
            }
          }
        }
        return {
          installId: value.installId,
          contentDigest: installation.contentDigest,
          name: loader.skill.name,
          ...loader.readResource(name === "skill.read" ? "SKILL.md" : (value.path ?? ""), value.offset, value.maxChars)
        };
      }
    }));
  }
  #scheduleUpdates() {
    this.#timer = setTimeout(() => {
      this.#updating = (async () => {
        for (const installation of this.service.store.list()) {
          if (this.#closed) break;
          try {
            await this.service.checkUpdates(installation.id);
          } catch {
            /* 单一来源离线不影响其他能力 */
          }
        }
      })().finally(() => {
        if (!this.#closed) this.#scheduleUpdates();
      });
    }, this.#config.capabilities.checkIntervalMs);
    this.#timer.unref();
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
