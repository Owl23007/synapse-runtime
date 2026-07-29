/** 网络请求函数 */
export type WebFetch = typeof globalThis.fetch;

/** DNS 查询结果 */
export interface WebDnsAddress {
  readonly address: string;
  readonly family: number;
}

/** DNS 查询函数 */
export type WebDnsLookup = (hostname: string) => Promise<readonly WebDnsAddress[]>;

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
}
