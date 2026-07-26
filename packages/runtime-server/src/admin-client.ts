export interface RuntimeAdminClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetch?: AdminFetch;
}

export type AdminFetch = (url: string, init?: AdminFetchInit) => Promise<AdminFetchResponse>;

export interface AdminFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface AdminFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export class RuntimeAdminClient {
  readonly #endpoint: string;
  readonly #token: string | undefined;
  readonly #fetch: AdminFetch;

  constructor(options: RuntimeAdminClientOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? defaultFetch;
  }

  health(): Promise<unknown> {
    return this.#get("/admin/health");
  }

  status(): Promise<unknown> {
    return this.#get("/admin/status");
  }

  config(): Promise<unknown> {
    return this.#get("/admin/config");
  }

  channels(): Promise<unknown> {
    return this.#get("/admin/channels");
  }

  updateChannel(channelId: string, patch: { readonly enabled?: boolean }): Promise<unknown> {
    return this.#request(`/admin/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  reload(): Promise<unknown> {
    return this.#request("/admin/reload", { method: "POST" });
  }

  shutdown(): Promise<unknown> {
    return this.#request("/admin/shutdown", { method: "POST" });
  }

  logs(options: { readonly limit?: number } = {}): Promise<unknown> {
    const query = options.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
    return this.#get(`/admin/logs${query}`);
  }

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

    while (!signal.aborted) {
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
    }
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
