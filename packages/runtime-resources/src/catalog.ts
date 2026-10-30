import { z } from "zod";

/** 第三方目录只返回发现元数据，不授予执行权限 */
export interface CatalogEntry {
  readonly moderation?: { verdict?: string | undefined; isMalwareBlocked: boolean; summary?: string | undefined };
  readonly provider: "clawhub" | "mcp-official";
  readonly packageId: string;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly author?: string;
  readonly license?: string;
  readonly url?: string;
  readonly remotes?: readonly { type: string; url: string }[];
}

/** 不同目录共享发现协议，下载与安装属于独立操作 */
export interface CatalogProvider {
  readonly id: string;
  /** 搜索不会下载包内容 */
  search(input: {
    query: string;
    cursor?: string | undefined;
  }): Promise<{ items: readonly CatalogEntry[]; nextCursor?: string }>;
  /** 查询版本元数据，不保证该版本能够在本地运行 */
  get(packageId: string, version?: string): Promise<CatalogEntry>;
  /** 查询具体来源的发布版本 */
  versions(packageId: string): Promise<{ items: readonly { version: string; changelog?: string }[] }>;
}

/** 目录错误保留可重试时间，不把响应原文或凭据传给浏览器 */
export class CatalogError extends Error {
  /** 保存稳定状态与退避信息 */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number
  ) {
    super(code);
  }
}

/** 有界响应缓存与来源级限流，搜索阶段没有安装副作用 */
export class CatalogHttp {
  readonly #cache = new Map<string, { expires: number; value: unknown }>();
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #backoff = new Map<string, number>();
  /** 传输由宿主提供 DNS 和地址约束 */
  constructor(readonly fetch: typeof globalThis.fetch) {}
  /** 缓存 JSON 并尊重服务端 Retry-After，缓存数量与输入长度均有限制 */
  async json(url: string): Promise<unknown> {
    if (url.length > 4096) throw new CatalogError(400, "catalog_query_too_long");
    const cached = this.#cache.get(url);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.value);
    const origin = new URL(url).origin;
    const backoff = this.#backoff.get(origin) ?? 0;
    if (backoff > Date.now())
      throw new CatalogError(429, "catalog_rate_limited", Math.ceil((backoff - Date.now()) / 1000));
    if (this.#pending.has(url)) return this.#pending.get(url)!;
    if (this.#pending.size >= 8) throw new CatalogError(429, "catalog_capacity");
    const request = (async () => {
      const response = await this.fetch(url, { headers: { accept: "application/json" } });
      if (response.status === 429) {
        const value = response.headers.get("retry-after") ?? "60";
        const seconds = /^\d+$/.test(value)
          ? Number(value)
          : Math.max(1, Math.ceil((Date.parse(value) - Date.now()) / 1000));
        const retryAfter = Number.isFinite(seconds) ? Math.min(seconds, 86400) : 60;
        this.#backoff.set(origin, Date.now() + retryAfter * 1000);
        throw new CatalogError(429, "catalog_rate_limited", retryAfter);
      }
      if (!response.ok) throw new CatalogError(response.status === 404 ? 404 : 502, "catalog_request_failed");
      const value: unknown = await response.json();
      if (this.#cache.size >= 128) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(url, { expires: Date.now() + 60_000, value });
      return value;
    })().finally(() => this.#pending.delete(url));
    this.#pending.set(url, request);
    return request;
  }
}

const text = z.string().max(16000);
const clawSkill = z.object({
  slug: text,
  displayName: text.optional(),
  summary: text.nullish(),
  version: text.nullish(),
  ownerHandle: text.nullish(),
  owner: z.object({ handle: text.nullish() }).nullish()
});
const registryServer = z.object({
  name: text,
  description: text.optional(),
  version: text,
  repository: z.object({ url: text }).optional(),
  remotes: z
    .array(z.object({ type: text, url: text }))
    .max(20)
    .optional()
});
function query(value: string) {
  if (value.length > 500) throw new CatalogError(400, "catalog_query_too_long");
  return value;
}
function segment(value: string) {
  if (!value || value.length > 300) throw new CatalogError(400, "invalid_package_id");
  return encodeURIComponent(value);
}

/** 作者限定的 ClawHub 身份避免同名包混淆，下载 URL 仍由官方端点构造 */
export function parseClawHubId(value: string): { slug: string; owner?: string } {
  if (!/^(?:[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9-]{0,100}$/.test(value))
    throw new CatalogError(400, "invalid_clawhub_id");
  const parts = value.split("/");
  return parts.length === 2 ? { owner: parts[0]!, slug: parts[1]! } : { slug: parts[0]! };
}

/** ClawHub 标准 Skill 目录适配，不加载 OpenClaw 插件 */
export class ClawHubCatalog implements CatalogProvider {
  readonly id = "clawhub";
  /** 官方目录只提供元数据，下载属于单独的安装步骤 */
  constructor(readonly http: CatalogHttp) {}
  async search(input: { query: string; cursor?: string | undefined }) {
    const data = z
      .object({ results: z.array(clawSkill.extend({ slug: text.optional() })).max(100) })
      .parse(await this.http.json(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query(input.query))}`));
    return { items: data.results.flatMap((item) => (item.slug ? [this.#entry({ ...item, slug: item.slug })] : [])) };
  }
  async get(packageId: string, version?: string): Promise<CatalogEntry> {
    const identity = parseClawHubId(packageId);
    const data = z
      .object({
        skill: clawSkill,
        owner: z.object({ handle: text.nullish() }).nullish(),
        latestVersion: z.object({ version: text }).nullish(),
        moderation: z
          .object({ verdict: text.optional(), isMalwareBlocked: z.boolean(), summary: text.nullish() })
          .nullish()
      })
      .parse(
        await this.http.json(
          `https://clawhub.ai/api/v1/skills/${segment(identity.slug)}${identity.owner ? `?ownerHandle=${encodeURIComponent(identity.owner)}` : ""}`
        )
      );
    return {
      ...this.#entry(data.skill),
      ...(data.owner?.handle
        ? {
            author: data.owner.handle,
            packageId: `${data.owner.handle}/${identity.slug}`,
            url: `https://clawhub.ai/${encodeURIComponent(data.owner.handle)}/skills/${segment(identity.slug)}`
          }
        : {}),
      ...(data.moderation
        ? {
            moderation: {
              isMalwareBlocked: data.moderation.isMalwareBlocked,
              ...(data.moderation.verdict ? { verdict: data.moderation.verdict } : {}),
              ...(data.moderation.summary ? { summary: data.moderation.summary } : {})
            }
          }
        : {}),
      ...((version ?? data.latestVersion?.version) ? { version: version ?? data.latestVersion!.version } : {})
    };
  }
  async versions(packageId: string) {
    const identity = parseClawHubId(packageId);
    const params = new URLSearchParams({ limit: "100", ...(identity.owner ? { ownerHandle: identity.owner } : {}) });
    const data = z
      .object({ items: z.array(z.object({ version: text, changelog: text.optional() })).max(100) })
      .parse(await this.http.json(`https://clawhub.ai/api/v1/skills/${segment(identity.slug)}/versions?${params}`));
    return {
      items: data.items.map((item) => ({
        version: item.version,
        ...(item.changelog ? { changelog: item.changelog } : {})
      }))
    };
  }
  #entry(item: z.infer<typeof clawSkill>): CatalogEntry {
    const owner = item.ownerHandle ?? item.owner?.handle;
    return {
      provider: "clawhub",
      packageId: owner ? `${owner}/${item.slug}` : item.slug,
      name: item.displayName ?? item.slug,
      description: item.summary ?? "",
      ...(item.version ? { version: item.version } : {}),
      ...(owner ? { author: owner } : {})
    };
  }
}

/** 官方 MCP Registry 只发现服务，不负责启动或担保远程代码版本 */
export class McpRegistryCatalog implements CatalogProvider {
  readonly id = "mcp-official";
  /** 固定公开 Registry，传输沿用宿主受限 HTTP */
  constructor(readonly http: CatalogHttp) {}
  async search(input: { query: string; cursor?: string | undefined }) {
    const params = new URLSearchParams({ search: query(input.query), version: "latest", limit: "50" });
    if (input.cursor) params.set("cursor", query(input.cursor));
    const data = z
      .object({
        servers: z.array(z.object({ server: registryServer })).max(100),
        metadata: z.object({ nextCursor: text.optional() }).optional()
      })
      .parse(await this.http.json(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`));
    return {
      items: data.servers.map((item) => this.#entry(item.server)),
      ...(data.metadata?.nextCursor ? { nextCursor: data.metadata.nextCursor } : {})
    };
  }
  async get(packageId: string, version = "latest") {
    const data = z
      .object({ server: registryServer })
      .parse(
        await this.http.json(
          `https://registry.modelcontextprotocol.io/v0.1/servers/${segment(packageId)}/versions/${segment(version)}`
        )
      );
    return this.#entry(data.server);
  }
  async versions(packageId: string) {
    const data = z
      .object({ servers: z.array(z.object({ server: registryServer })).max(200) })
      .parse(
        await this.http.json(`https://registry.modelcontextprotocol.io/v0.1/servers/${segment(packageId)}/versions`)
      );
    return { items: data.servers.map((item) => ({ version: item.server.version })) };
  }
  #entry(server: z.infer<typeof registryServer>): CatalogEntry {
    return {
      provider: "mcp-official",
      packageId: server.name,
      name: server.name,
      description: server.description ?? "",
      version: server.version,
      ...(server.repository ? { url: server.repository.url } : {}),
      ...(server.remotes ? { remotes: server.remotes } : {})
    };
  }
}
