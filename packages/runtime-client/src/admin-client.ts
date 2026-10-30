import type {
  AdminFetch,
  AdminFetchInit,
  AdminFetchResponse,
  RuntimeAdminClientOptions
} from "./admin-client-types.js";
import type {
  RunTrace,
  RunQuery,
  RunListResponse,
  RunEventsResponse,
  RunStreamOptions,
  InspectionPage
} from "./run-types.js";
import { subscribeRuns } from "./run-stream.js";
import type { WorkspaceView, WorkspaceSession, WorkspaceBranch, SessionGraphView } from "./workspace-types.js";
import type {
  ResourceWorkspace,
  AssetInfo,
  AssetDetail,
  AssetVersionInfo,
  CapabilityInfo,
  CapabilityBinding,
  CatalogItem,
  McpConnectionInfo
} from "./resource-types.js";

export type {
  AdminFetch,
  AdminFetchInit,
  AdminFetchResponse,
  RuntimeAdminClientOptions
} from "./admin-client-types.js";

/**
 * Runtime Admin HTTP 客户端
 */
export class RuntimeAdminClient {
  readonly #endpoint: string;
  readonly #token: string | undefined;
  readonly #fetch: AdminFetch;

  /** 创建 Admin HTTP 客户端 */
  constructor(options: RuntimeAdminClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? defaultFetch;
  }

  /** 按状态、频道、会话及时间分页检查运行 */
  runs(query: RunQuery = {}): Promise<RunListResponse> {
    return this.#get(`/admin/runs${queryString(query)}`) as Promise<RunListResponse>;
  }

  /** 读取一个逻辑运行的状态与关联对象 */
  run(id: string): Promise<{ readonly ok: true; readonly run: RunTrace }> {
    return this.#get(`/admin/runs/${encodeURIComponent(id)}`) as Promise<{ readonly ok: true; readonly run: RunTrace }>;
  }

  /** 读取运行内增量事件 */
  runEvents(id: string, afterSeq = 0, limit = 100): Promise<RunEventsResponse> {
    return this.#get(
      `/admin/runs/${encodeURIComponent(id)}/events${queryString({ afterSeq, limit })}`
    ) as Promise<RunEventsResponse>;
  }

  /** 读取本次执行的实际上下文快照 */
  runContext(id: string): Promise<unknown> {
    return this.#get(`/admin/runs/${encodeURIComponent(id)}/context`);
  }

  /** 持久运行流，自动重连并按已处理游标补读 */
  streamRuns(options: RunStreamOptions): () => void {
    return subscribeRuns(this.#fetch, this.#endpoint, this.#token, options);
  }

  /** 分页浏览会话 */
  sessions(before?: number): Promise<InspectionPage> {
    return this.#get(`/admin/sessions${queryString({ before })}`) as Promise<InspectionPage>;
  }

  /** 创建无需外部频道的持久原生会话 */
  createSession(title: string, idempotencyKey: string): Promise<{ session: WorkspaceSession }> {
    return this.#request("/admin/sessions", {
      method: "POST",
      body: JSON.stringify({ title, idempotencyKey })
    }) as Promise<{ session: WorkspaceSession }>;
  }

  /** 在指定会话线上发起真实 Agent 运行，重试沿用原幂等键 */
  submitRun(input: {
    sessionId: string;
    lineId: string;
    text: string;
    idempotencyKey: string;
    attachments?: readonly { assetId: string; versionId: string }[];
  }): Promise<{ run: RunTrace }> {
    return this.#request("/admin/runs", { method: "POST", body: JSON.stringify(input) }) as Promise<{ run: RunTrace }>;
  }

  /** 列出持久资源工作区，供文件和能力页面共用 */
  resourceWorkspaces(): Promise<{ items: readonly ResourceWorkspace[] }> {
    return this.#get("/admin/workspaces") as Promise<{ items: readonly ResourceWorkspace[] }>;
  }

  /** 从可信会话映射获取资源工作区 */
  sessionResourceWorkspace(id: string): Promise<{ workspaceId: string }> {
    return this.#get(`/admin/sessions/${encodeURIComponent(id)}/resource-workspace`) as Promise<{
      workspaceId: string;
    }>;
  }

  /** 搜索元数据不会物化远端文件 */
  assets(
    workspaceId: string,
    query: { q?: string; source?: string; cursor?: string } = {}
  ): Promise<{ items: readonly AssetInfo[]; nextCursor?: string }> {
    return this.#get(`/admin/workspaces/${encodeURIComponent(workspaceId)}/assets${queryString(query)}`) as Promise<{
      items: readonly AssetInfo[];
      nextCursor?: string;
    }>;
  }

  /** 查询文件的来源、版本及运行关系 */
  asset(id: string): Promise<AssetDetail> {
    return this.#get(`/admin/assets/${encodeURIComponent(id)}`) as Promise<AssetDetail>;
  }

  /** 明确预览或 Agent 使用时才下载远端文件 */
  materializeAsset(id: string): Promise<{ version: AssetVersionInfo }> {
    return this.#request(`/admin/assets/${encodeURIComponent(id)}/materialize`, { method: "POST" }) as Promise<{
      version: AssetVersionInfo;
    }>;
  }

  /** 两阶段原始二进制上传，重试必须沿用调用方保留的幂等键 */
  async uploadAsset(
    workspaceId: string,
    file: File,
    idempotencyKey: string,
    assetId?: string
  ): Promise<{ asset: AssetInfo; version: AssetVersionInfo }> {
    const path = assetId
      ? `/admin/assets/${encodeURIComponent(assetId)}/versions`
      : `/admin/workspaces/${encodeURIComponent(workspaceId)}/assets/uploads`;
    const init = (await this.#request(path, {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        idempotencyKey
      })
    })) as { uploadId: string };
    return this.#request(`/admin/assets/uploads/${encodeURIComponent(init.uploadId)}/content`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: await file.arrayBuffer()
    }) as Promise<{ asset: AssetInfo; version: AssetVersionInfo }>;
  }

  /** 文件内容通过认证头读取，凭据不会进入 URL */
  async downloadAsset(id: string, versionId?: string): Promise<Blob> {
    const response = await this.#fetch(
      `${this.#endpoint}/admin/assets/${encodeURIComponent(id)}/content${queryString({ versionId })}`,
      { method: "GET", headers: { ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) } }
    );
    if (!response.ok || !response.body) throw new Error(`文件下载失败：HTTP ${response.status}`);
    return new Response(response.body).blob();
  }

  /** 修改逻辑展示名，不改远端平台文件 */
  renameAsset(id: string, name: string): Promise<unknown> {
    return this.#request(`/admin/assets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  /** 软删除保留历史版本与运行引用 */
  deleteAsset(id: string): Promise<unknown> {
    return this.#request(`/admin/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** 手动同步真实群文件列表，不产生 Run */
  syncFiles(channelId: string, groupId: string, folderId?: string): Promise<unknown> {
    return this.#request("/admin/files/sync", {
      method: "POST",
      body: JSON.stringify({ channelId, groupId, ...(folderId ? { folderId } : {}) })
    });
  }

  /** 只读挂载清单不会批量导入资源 */
  mounts(workspaceId: string): Promise<{ items: readonly { id: string; access: string; urlPrefix: string }[] }> {
    return this.#get(`/admin/workspaces/${encodeURIComponent(workspaceId)}/mounts`) as Promise<{
      items: readonly { id: string; access: string; urlPrefix: string }[];
    }>;
  }

  /** 只读浏览目录的相对路径 */
  mountEntries(
    id: string,
    path = ""
  ): Promise<{ items: readonly { name: string; directory: boolean }[]; truncated: boolean }> {
    return this.#get(`/admin/mounts/${encodeURIComponent(id)}/entries${queryString({ path })}`) as Promise<{
      items: readonly { name: string; directory: boolean }[];
      truncated: boolean;
    }>;
  }

  /** 明确选择挂载文件时固定内容副本 */
  materializeMount(
    workspaceId: string,
    mountId: string,
    path: string
  ): Promise<{ asset: AssetInfo; version: AssetVersionInfo }> {
    return this.#request(
      `/admin/workspaces/${encodeURIComponent(workspaceId)}/mounts/${encodeURIComponent(mountId)}/materialize`,
      { method: "POST", body: JSON.stringify({ path }) }
    ) as Promise<{ asset: AssetInfo; version: AssetVersionInfo }>;
  }

  /** Runtime 已安装版本列表 */
  capabilities(): Promise<{ items: readonly CapabilityInfo[] }> {
    return this.#get("/admin/capabilities") as Promise<{ items: readonly CapabilityInfo[] }>;
  }

  /** 浏览公开目录只读取元数据 */
  searchCatalog(
    provider: string,
    q: string,
    cursor?: string
  ): Promise<{ items: readonly CatalogItem[]; nextCursor?: string }> {
    return this.#get(`/admin/catalogs/${encodeURIComponent(provider)}/search${queryString({ q, cursor })}`) as Promise<{
      items: readonly CatalogItem[];
      nextCursor?: string;
    }>;
  }

  /** 查询来源精确发布版本，安装阶段不得使用 latest */
  catalogVersions(
    provider: string,
    packageId: string
  ): Promise<{ items: readonly { version: string; changelog?: string }[] }> {
    return this.#get(
      `/admin/catalogs/${encodeURIComponent(provider)}/items/${encodeURIComponent(packageId)}/versions`
    ) as Promise<{ items: readonly { version: string; changelog?: string }[] }>;
  }

  /** 安装后仍需单独启用工作区，浏览器不能提交启动命令 */
  installCapability(input: unknown): Promise<{ installation: CapabilityInfo }> {
    return this.#request("/admin/capabilities/install", { method: "POST", body: JSON.stringify(input) }) as Promise<{
      installation: CapabilityInfo;
    }>;
  }

  /** 渐进读取已安装 Skill 的内容用于人工审阅 */
  capabilityResource(
    id: string,
    path: string
  ): Promise<{ resource: { text?: string; binary?: boolean; hasMore?: boolean } }> {
    return this.#get(`/admin/capabilities/${encodeURIComponent(id)}/resource${queryString({ path })}`) as Promise<{
      resource: { text?: string; binary?: boolean; hasMore?: boolean };
    }>;
  }

  /** 查询工作区能力绑定 */
  workspaceCapabilities(id: string): Promise<{ items: readonly CapabilityBinding[] }> {
    return this.#get(`/admin/workspaces/${encodeURIComponent(id)}/capabilities`) as Promise<{
      items: readonly CapabilityBinding[];
    }>;
  }

  /** 原子启用、停用或回滚到已安装版本 */
  bindCapability(
    workspaceId: string,
    packageKey: string,
    input: { installId: string; enabled: boolean; settings?: Readonly<Record<string, unknown>> }
  ): Promise<unknown> {
    return this.#request(
      `/admin/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(packageKey)}`,
      { method: "PUT", body: JSON.stringify(input) }
    );
  }

  /** 查询更新只读来源，不切换已启用版本 */
  checkCapabilityUpdates(id: string): Promise<unknown> {
    return this.#request(`/admin/capabilities/${encodeURIComponent(id)}/check-updates`, { method: "POST" });
  }

  /** 读取最近更新检查结果 */
  capabilityUpdates(): Promise<{ items: readonly Record<string, unknown>[] }> {
    return this.#get("/admin/capabilities/updates") as Promise<{ items: readonly Record<string, unknown>[] }>;
  }

  /** 查询实际 MCP 协商与工具发现状态 */
  mcpConnections(): Promise<{ items: readonly McpConnectionInfo[] }> {
    return this.#get("/admin/mcp/connections") as Promise<{ items: readonly McpConnectionInfo[] }>;
  }

  /** 人工确认重新发现工具 Schema，不重放任何工具调用 */
  reconnectMcp(id: string): Promise<unknown> {
    return this.#request(`/admin/mcp/connections/${encodeURIComponent(id)}/connect`, { method: "POST" });
  }

  /** 检查 Run 固定的文件和能力版本 */
  runDependencies(id: string): Promise<unknown> {
    return this.#get(`/admin/runs/${encodeURIComponent(id)}/dependencies`);
  }

  /** 按会话线读取消息与可操作分支 */
  workspace(sessionId: string, lineId?: string, before?: number): Promise<WorkspaceView> {
    return this.#get(
      `/admin/sessions/${encodeURIComponent(sessionId)}/workspace${queryString({ lineId, before })}`
    ) as Promise<WorkspaceView>;
  }

  /** 单次读取完整预算内子图，历史浏览不会触发任何执行 */
  sessionGraph(sessionId: string, head?: string): Promise<SessionGraphView> {
    return this.#get(
      `/admin/sessions/${encodeURIComponent(sessionId)}/graph${queryString({ head })}`
    ) as Promise<SessionGraphView>;
  }

  /** 从选定不可变提交建立可继续对话的分支 */
  forkSession(
    sessionId: string,
    input: { commitId: string; title: string; idempotencyKey: string }
  ): Promise<{ branch: WorkspaceBranch }> {
    return this.#request(`/admin/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: "POST",
      body: JSON.stringify(input)
    }) as Promise<{ branch: WorkspaceBranch }>;
  }

  /** 显式合并已比较的分支头，目标版本或来源变化时返回冲突 */
  mergeSession(
    sessionId: string,
    input: { branchId: string; expectedVersion: number; sourceCommitId: string; idempotencyKey: string }
  ): Promise<unknown> {
    return this.#request(`/admin/sessions/${encodeURIComponent(sessionId)}/merge`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  /** 分页检查会话消息 */
  transcript(sessionId: string, before?: number): Promise<InspectionPage> {
    return this.#get(
      `/admin/sessions/${encodeURIComponent(sessionId)}/transcript${queryString({ before })}`
    ) as Promise<InspectionPage>;
  }

  /** 分页检查会话引用 */
  refs(sessionId: string, after?: string): Promise<InspectionPage> {
    return this.#get(
      `/admin/sessions/${encodeURIComponent(sessionId)}/refs${queryString({ after })}`
    ) as Promise<InspectionPage>;
  }

  /** 检查指定会话内的不可变提交 */
  commit(sessionId: string, id: string): Promise<unknown> {
    return this.#get(`/admin/commits/${encodeURIComponent(id)}${queryString({ sessionId })}`);
  }

  /** 分页检查会话工件 */
  artifacts(sessionId: string, after?: string): Promise<InspectionPage> {
    return this.#get(`/admin/artifacts${queryString({ sessionId, after })}`) as Promise<InspectionPage>;
  }

  /** 检查已登记工件元数据 */
  artifact(sessionId: string, id: string): Promise<unknown> {
    return this.#get(`/admin/artifacts/${encodeURIComponent(id)}${queryString({ sessionId })}`);
  }

  /** 使用认证头下载已登记工件，令牌不会出现在下载 URL 中 */
  async downloadArtifact(sessionId: string, id: string): Promise<Blob> {
    const response = await this.#fetch(
      `${this.#endpoint}/admin/artifacts/${encodeURIComponent(id)}/content${queryString({ sessionId })}`,
      { method: "GET", headers: { ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }) } }
    );
    if (!response.ok || !response.body) throw new Error(`工件下载失败：HTTP ${response.status}`);
    return new Response(response.body).blob();
  }

  /** 检查 Admin 服务健康状态 */
  health(): Promise<unknown> {
    return this.#get("/admin/health");
  }

  /** 读取运行时状态 */
  status(): Promise<unknown> {
    return this.#get("/admin/status");
  }

  /** 读取脱敏配置 */
  config(): Promise<unknown> {
    return this.#get("/admin/config");
  }

  /** 读取频道状态 */
  channels(): Promise<unknown> {
    return this.#get("/admin/channels");
  }

  /** 查询会话分支 */
  branches(sessionId?: string): Promise<unknown> {
    const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    return this.#get(`/admin/branches${query}`);
  }

  /** 获取指定分支 */
  branch(branchId: string): Promise<unknown> {
    return this.#get(`/admin/branches/${encodeURIComponent(branchId)}`);
  }

  /** 查询分支任务 */
  tasks(branchId?: string): Promise<unknown> {
    const query = branchId === undefined ? "" : `?branchId=${encodeURIComponent(branchId)}`;
    return this.#get(`/admin/tasks${query}`);
  }

  /** 获取指定任务 */
  task(taskId: string): Promise<unknown> {
    return this.#get(`/admin/tasks/${encodeURIComponent(taskId)}`);
  }

  /** 请求取消指定任务 */
  cancelTask(taskId: string): Promise<unknown> {
    return this.#request(`/admin/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }

  /** 更新频道启用状态 */
  updateChannel(channelId: string, patch: { readonly enabled?: boolean }): Promise<unknown> {
    return this.#request(`/admin/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  /** 重新加载运行时配置 */
  reload(): Promise<unknown> {
    return this.#request("/admin/reload", { method: "POST" });
  }

  /** 修改服务端持久化频道配置，调用 reload 后应用 */
  updateChannelConfig(channelId: string, patch: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#request(`/admin/config/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  /** 新增服务端持久化频道配置，调用 reload 后应用 */
  addChannelConfig(channelId: string, config: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#request(`/admin/config/channels/${encodeURIComponent(channelId)}`, {
      method: "POST",
      body: JSON.stringify(config)
    });
  }

  /** 请求关闭运行时 */
  shutdown(): Promise<unknown> {
    return this.#request("/admin/shutdown", { method: "POST" });
  }

  /** 读取最近日志 */
  logs(options: { readonly limit?: number } = {}): Promise<unknown> {
    const query = options.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
    return this.#get(`/admin/logs${query}`);
  }

  /** 订阅服务端日志流 */
  streamLogs(onLog: (entry: unknown) => void, onError?: (error: Error) => void): () => void {
    const abort = new AbortController();
    void this.#streamLogs(abort.signal, onLog).catch((error: unknown) => {
      if (abort.signal.aborted) {
        return;
      }

      onError?.(error instanceof Error ? error : new Error("Admin log stream failed."));
    });
    return () => abort.abort();
  }

  #get(path: string): Promise<unknown> {
    return this.#request(path, { method: "GET" });
  }

  async #request(path: string, init: AdminFetchInit): Promise<unknown> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
        ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` })
      },
      ...(init.body === undefined ? {} : { body: init.body })
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(`Admin API request failed with HTTP ${response.status}: ${safeJson(body)}`);
    }

    return body;
  }

  async #streamLogs(signal: AbortSignal, onLog: (entry: unknown) => void): Promise<void> {
    const response = await this.#fetch(`${this.#endpoint}/admin/events/stream`, {
      method: "GET",
      signal,
      headers: {
        accept: "text/event-stream",
        ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` })
      }
    });

    if (!response.ok) {
      throw new Error(`Admin log stream failed with HTTP ${response.status}.`);
    }

    if (response.body === undefined || response.body === null) {
      throw new Error("Admin log stream response has no body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readNext = async (): Promise<void> => {
      if (signal.aborted) {
        return;
      }

      const result = await reader.read();

      if (result.done) {
        return;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");

        if (data.length === 0) {
          continue;
        }

        onLog(JSON.parse(data));
      }

      return readNext();
    };

    return readNext();
  }
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}

async function defaultFetch(url: string, init?: AdminFetchInit): Promise<AdminFetchResponse> {
  if (globalThis.fetch === undefined) {
    throw new Error("No fetch implementation is available in this runtime.");
  }

  return globalThis.fetch(url, init) as Promise<AdminFetchResponse>;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable response]";
  }
}
