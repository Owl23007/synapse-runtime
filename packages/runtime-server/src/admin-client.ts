import type {
  AdminFetch,
  AdminFetchInit,
  AdminFetchResponse,
  RuntimeAdminClientOptions
} from "./admin-client-types.js";

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

  branches(sessionId?: string): Promise<unknown> {
    const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    return this.#get(`/admin/branches${query}`);
  }

  branch(branchId: string): Promise<unknown> {
    return this.#get(`/admin/branches/${encodeURIComponent(branchId)}`);
  }

  tasks(branchId?: string): Promise<unknown> {
    const query = branchId === undefined ? "" : `?branchId=${encodeURIComponent(branchId)}`;
    return this.#get(`/admin/tasks${query}`);
  }

  task(taskId: string): Promise<unknown> {
    return this.#get(`/admin/tasks/${encodeURIComponent(taskId)}`);
  }

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
