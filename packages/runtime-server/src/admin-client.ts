export interface RuntimeAdminClientOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly fetch?: AdminFetch;
}

export type AdminFetch = (url: string, init?: AdminFetchInit) => Promise<AdminFetchResponse>;

export interface AdminFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AdminFetchResponse {
  readonly ok: boolean;
  readonly status: number;
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

  logs(options: { readonly limit?: number } = {}): Promise<unknown> {
    const query = options.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
    return this.#get(`/admin/logs${query}`);
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` })
      }
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(`Admin API request failed with HTTP ${response.status}: ${safeJson(body)}`);
    }

    return body;
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
