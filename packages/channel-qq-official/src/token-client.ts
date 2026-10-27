import { QQ_OFFICIAL_TOKEN_ENDPOINT } from "./constants.js";
import type {
  QqOfficialAccessToken,
  QqOfficialAccessTokenClientOptions,
  FetchLike,
  TokenResponseBody
} from "./types.js";
import { defaultFetch, redactSensitive, safeJson } from "./utils.js";

/** 管理服务端访问令牌及过期前缓存，不将 HTTP 200 误当作业务鉴权成功 */
export class QqOfficialAccessTokenClient {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #tokenEndpoint: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #cached?: { readonly accessToken: string; readonly expiresAtMs: number };

  constructor(options: QqOfficialAccessTokenClientOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#tokenEndpoint = options.tokenEndpoint ?? QQ_OFFICIAL_TOKEN_ENDPOINT;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? Date.now;
  }

  /** 缓存在到期前六十秒失效，平台返回的剩余有效期可能小于两小时 */
  async getAccessToken(): Promise<string> {
    if (this.#cached !== undefined && this.#cached.expiresAtMs > this.#now() + 60_000) {
      return this.#cached.accessToken;
    }

    const token = await this.refreshAccessToken();
    return token.accessToken;
  }

  /** 根据 HTTP 状态及业务 code 共同校验鉴权回执 */
  async refreshAccessToken(): Promise<QqOfficialAccessToken> {
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        appId: this.#appId,
        clientSecret: this.#appSecret
      })
    });

    const body = (await response.json()) as TokenResponseBody;

    if (!response.ok) {
      throw new Error(
        `QQ official token request failed with HTTP ${response.status}: ${safeJson(redactSensitive(body))}`
      );
    }
    const accessToken = parseRequiredString(body.access_token ?? body.accessToken, "access_token/accessToken", body);
    if (body.code !== undefined && body.code !== 0 && body.code !== "0") {
      const code = typeof body.code === "number" || typeof body.code === "string" ? String(body.code) : "invalid";
      throw new Error(`QQ official token request rejected (code ${code}).`);
    }

    const expiresIn = parseExpiresIn(body.expires_in ?? body.expiresIn, body);
    this.#cached = {
      accessToken,
      expiresAtMs: this.#now() + expiresIn * 1000
    };

    return { accessToken, expiresIn };
  }
}

function parseRequiredString(value: unknown, field: string, body?: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`QQ official token response is missing "${field}": ${safeJson(redactSensitive(body))}`);
  }

  return value;
}

function parseExpiresIn(value: unknown, body?: unknown): number {
  if (value === undefined) {
    return 7200;
  }

  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`QQ official token response is missing "expires_in/expiresIn": ${safeJson(redactSensitive(body))}`);
  }

  return parsed;
}
