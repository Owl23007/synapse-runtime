/** 网络请求函数 */
export type WebFetch = typeof globalThis.fetch;

/** DNS 查询结果 */
export interface WebDnsAddress {
  readonly address: string;
  readonly family: number;
}

/** DNS 查询函数 */
export type WebDnsLookup = (hostname: string) => Promise<readonly WebDnsAddress[]>;

/** Web 工具结果缓存契约，缓存键必须包含租户或工作区隔离信息 */
export interface WebCache {
  /** 读取未过期的缓存值 */
  get<T>(key: string): Promise<T | undefined>;
  /** 写入带过期时间的缓存值 */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

/** 进程内 Web 结果缓存，适用于单 Runtime 部署与测试 */
export class InMemoryWebCache implements WebCache {
  readonly #entries = new Map<string, { readonly value: unknown; readonly expiresAt: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

/** Brave 搜索配置 */
export interface BraveWebSearchOptions {
  readonly provider: "brave";
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/** SearXNG 搜索配置 */
export interface SearxngWebSearchOptions {
  readonly provider: "searxng";
  readonly baseUrl: string;
}

/** 网络搜索提供商配置 */
export type WebSearchOptions = BraveWebSearchOptions | SearxngWebSearchOptions;

/** 内置网络工具配置 */
export interface WebToolOptions {
  readonly search?: WebSearchOptions;
  readonly allowedDomains?: readonly string[];
  readonly deniedDomains?: readonly string[];
  readonly allowPrivateNetwork?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxContentChars?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  readonly fetch?: WebFetch;
  readonly lookup?: WebDnsLookup;
  readonly cache?: WebCache;
  readonly cacheTtlMs?: number;
}

/** 规范化搜索结果 */
export interface WebSearchResult {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source: string;
  readonly publishedAt?: string;
}

/** 网络搜索工具输出 */
export interface WebSearchOutput {
  readonly query: string;
  readonly provider: "brave" | "searxng";
  readonly searchedAt: string;
  readonly results: readonly WebSearchResult[];
  readonly cacheHit?: boolean;
}

/** 网页抓取工具输出 */
export interface WebFetchOutput {
  readonly requestedUrl: string;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly fetchedAt: string;
  readonly notice: string;
  readonly cacheHit?: boolean;
}
