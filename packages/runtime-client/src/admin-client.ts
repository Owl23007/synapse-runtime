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
