export type QqOfficialMode = "webhook" | "websocket";

export interface QqOfficialChannelAdapterOptions {
  readonly id: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly mode?: QqOfficialMode;
  readonly apiBaseUrl?: string;
  readonly tokenEndpoint?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface QqOfficialAccessTokenClientOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly tokenEndpoint?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface QqOfficialAccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export interface QqOfficialWebhookValidationRequest {
  readonly plain_token: string;
  readonly event_ts: string;
}

export interface QqOfficialWebhookValidationResponse {
  readonly plain_token: string;
  readonly signature: string;
}

export interface QqOfficialDispatchPayload {
  readonly op?: number;
  readonly t?: string;
  readonly id?: string;
  readonly d?: unknown;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface TokenResponseBody {
  readonly access_token?: unknown;
  readonly accessToken?: unknown;
  readonly expires_in?: unknown;
  readonly expiresIn?: unknown;
}

export interface QqOfficialMessagePayload {
  readonly id?: string;
  readonly msg_id?: string;
  readonly event_id?: string;
  readonly content?: string;
  readonly timestamp?: string;
  readonly author?: {
    readonly id?: string;
    readonly user_openid?: string;
    readonly username?: string;
  };
  readonly group_id?: string;
  readonly group_openid?: string;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly user_openid?: string;
  readonly raw_message?: unknown;
  readonly mentions?: unknown;
  readonly message_reference?: unknown;
  readonly referenced_message?: unknown;
  readonly reply?: unknown;
}
