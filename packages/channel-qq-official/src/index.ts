import { createPrivateKey, sign } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEventHandler,
  ChannelStatus,
  ChannelTarget,
  SendResult
} from "@synapse/runtime-channel";
import { textMessage, type SynapseChannelEvent, type SynapseMessage } from "@synapse/runtime-protocol";

export const QQ_OFFICIAL_API_BASE_URL = "https://api.sgroup.qq.com";
export const QQ_OFFICIAL_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";

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

type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

interface TokenResponseBody {
  readonly access_token?: unknown;
  readonly accessToken?: unknown;
  readonly expires_in?: unknown;
  readonly expiresIn?: unknown;
}

interface QqOfficialMessagePayload {
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
}

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

  async getAccessToken(): Promise<string> {
    if (this.#cached !== undefined && this.#cached.expiresAtMs > this.#now() + 60_000) {
      return this.#cached.accessToken;
    }

    const token = await this.refreshAccessToken();
    return token.accessToken;
  }

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
      throw new Error(`QQ official token request failed with HTTP ${response.status}: ${safeJson(redactSensitive(body))}`);
    }

    const accessToken = parseRequiredString(body.access_token ?? body.accessToken, "access_token/accessToken", body);
    const expiresIn = parseExpiresIn(body.expires_in ?? body.expiresIn, body);
    this.#cached = {
      accessToken,
      expiresAtMs: this.#now() + expiresIn * 1000
    };

    return { accessToken, expiresIn };
  }
}

export class QqOfficialChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "qq-official";
  readonly provider = "qq-official";
  readonly #mode: QqOfficialMode;
  readonly #apiBaseUrl: string;
  readonly #tokenClient: QqOfficialAccessTokenClient;
  readonly #fetch: FetchLike;
  readonly #handlers = new Set<ChannelEventHandler>();
  #status: ChannelStatus = { state: "offline", checkedAt: new Date(0).toISOString() };

  constructor(options: QqOfficialChannelAdapterOptions) {
    this.id = options.id;
    this.#mode = options.mode ?? "webhook";
    this.#apiBaseUrl = options.apiBaseUrl ?? QQ_OFFICIAL_API_BASE_URL;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#tokenClient = new QqOfficialAccessTokenClient({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.tokenEndpoint === undefined ? {} : { tokenEndpoint: options.tokenEndpoint }),
      fetch: this.#fetch,
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  async connect(): Promise<void> {
    this.#status = { state: "connecting", checkedAt: new Date().toISOString() };
    this.#status = {
      state: "online",
      detail:
        this.#mode === "webhook"
          ? "Webhook mode is ready; access token will be requested lazily before sending."
          : "Gateway loop is not started by this adapter yet; access token will be requested lazily before sending.",
      checkedAt: new Date().toISOString()
    };
  }

  async disconnect(): Promise<void> {
    this.#status = { state: "offline", checkedAt: new Date().toISOString() };
  }

  async getStatus(): Promise<ChannelStatus> {
    return this.#status;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      receivePrivateMessage: true,
      receiveGroupMessage: true,
      receiveAllGroupMessages: false,
      requiresMention: true,
      sendPrivateMessage: true,
      sendGroupMessage: true,
      sendMedia: false,
      manageGroup: false,
      recallMessage: false,
      complianceLevel: "official",
      riskLevel: "low"
    };
  }

  async sendMessage(target: ChannelTarget, message: SynapseMessage): Promise<SendResult> {
    const content = renderTextMessage(message);
    const accessToken = await this.#tokenClient.getAccessToken();
    const url = this.#sendMessageUrl(target);
    const body = createQqOfficialSendBody(target, message, content);
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `QQBot ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const responseBody = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: `QQ official send failed with HTTP ${response.status}: ${safeJson(responseBody)}`
      };
    }

    const messageId = extractMessageId(responseBody);

    return {
      ok: true,
      ...(messageId === undefined ? {} : { messageId })
    };
  }

  onEvent(handler: ChannelEventHandler): void {
    this.#handlers.add(handler);
  }

  async handlePayload(payload: QqOfficialDispatchPayload): Promise<readonly SynapseChannelEvent[]> {
    const event = normalizeQqOfficialDispatch(this.id, payload);

    if (event === undefined) {
      return [];
    }

    await Promise.all([...this.#handlers].map((handler) => handler(event)));
    return [event];
  }

  #sendMessageUrl(target: ChannelTarget): string {
    const baseUrl = this.#apiBaseUrl.replace(/\/$/, "");

    if (target.type === "private") {
      return `${baseUrl}/v2/users/${encodeURIComponent(target.userId)}/messages`;
    }

    if (target.type === "group") {
      return `${baseUrl}/v2/groups/${encodeURIComponent(target.groupId)}/messages`;
    }

    return `${baseUrl}/channels/${encodeURIComponent(target.channelId)}/messages`;
  }
}

export function createQqOfficialWebhookValidationResponse(
  appSecret: string,
  request: QqOfficialWebhookValidationRequest
): QqOfficialWebhookValidationResponse {
  return {
    plain_token: request.plain_token,
    signature: signQqOfficialWebhookValidation(appSecret, request)
  };
}

export function signQqOfficialWebhookValidation(
  appSecret: string,
  request: QqOfficialWebhookValidationRequest
): string {
  const seed = repeatToLength(Buffer.from(appSecret, "utf8"), 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed
    ]),
    format: "der",
    type: "pkcs8"
  });
  const message = Buffer.from(`${request.event_ts}${request.plain_token}`, "utf8");

  return sign(null, message, privateKey).toString("hex");
}

export function normalizeQqOfficialDispatch(
  channelId: string,
  payload: QqOfficialDispatchPayload
): SynapseChannelEvent | undefined {
  if (payload.op !== undefined && payload.op !== 0) {
    return undefined;
  }

  if (payload.t === undefined || payload.d === undefined || !isRecord(payload.d)) {
    return undefined;
  }

  const messagePayload = payload.d as QqOfficialMessagePayload;
  const conversation = conversationFromPayload(payload.t, messagePayload);

  if (conversation === undefined) {
    return undefined;
  }

  const eventId =
    stringFromUnknown(payload.id) ??
    stringFromUnknown(messagePayload.event_id) ??
    stringFromUnknown(messagePayload.id) ??
    `${payload.t}:${Date.now()}`;
  const messageId = stringFromUnknown(messagePayload.msg_id) ?? stringFromUnknown(messagePayload.id);

  return {
    id: eventId,
    platform: "qq",
    channelId,
    eventType: "message.created",
    conversation,
    sender: {
      id:
        stringFromUnknown(messagePayload.author?.user_openid) ??
        stringFromUnknown(messagePayload.author?.id) ??
        stringFromUnknown(messagePayload.user_openid) ??
        "unknown",
      ...(messagePayload.author?.username === undefined ? {} : { displayName: messagePayload.author.username })
    },
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: "text",
      segments: [{ type: "text", text: messagePayload.content ?? "" }],
      replyTo: {
        ...(messageId === undefined ? {} : { messageId }),
        eventId,
        sequence: 1
      },
      raw: messagePayload.raw_message ?? payload.d
    },
    raw: payload,
    receivedAt: messagePayload.timestamp ?? new Date().toISOString()
  };
}

function conversationFromPayload(
  eventType: string,
  payload: QqOfficialMessagePayload
): SynapseChannelEvent["conversation"] | undefined {
  if (eventType === "C2C_MESSAGE_CREATE") {
    const userId = stringFromUnknown(payload.user_openid) ?? stringFromUnknown(payload.author?.user_openid);
    return userId === undefined ? undefined : { id: userId, kind: "private" };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    const groupId = stringFromUnknown(payload.group_openid) ?? stringFromUnknown(payload.group_id);
    return groupId === undefined ? undefined : { id: groupId, kind: "group" };
  }

  if (eventType === "AT_MESSAGE_CREATE" || eventType === "MESSAGE_CREATE" || eventType === "DIRECT_MESSAGE_CREATE") {
    const id = stringFromUnknown(payload.channel_id) ?? stringFromUnknown(payload.guild_id);
    return id === undefined ? undefined : { id, kind: "channel" };
  }

  return undefined;
}

function createQqOfficialSendBody(
  target: ChannelTarget,
  message: SynapseMessage,
  content: string
): Readonly<Record<string, unknown>> {
  const reply = message.replyTo;
  const messageId = reply?.messageId;
  const replyFields = {
    ...(messageId !== undefined
      ? { msg_id: messageId }
      : reply?.eventId === undefined
        ? {}
        : { event_id: reply.eventId }),
    msg_seq: reply?.sequence ?? (messageId === undefined ? 1 : createQqOfficialMessageSequence(messageId))
  };

  if (target.type === "channel") {
    return {
      content,
      ...replyFields
    };
  }

  return {
    content,
    msg_type: 0,
    ...replyFields
  };
}

function createQqOfficialMessageSequence(messageId: string): number {
  let hash = 0;

  for (let index = 0; index < messageId.length; index += 1) {
    hash = (hash * 31 + messageId.charCodeAt(index)) >>> 0;
  }

  return (hash ^ Date.now() ^ Math.floor(Math.random() * 65_536)) & 0xffff;
}

function renderTextMessage(message: SynapseMessage): string {
  const text = message.segments
    .filter((segment): segment is Extract<SynapseMessage["segments"][number], { type: "text" }> => segment.type === "text")
    .map((segment) => segment.text)
    .join("");

  if (text.length === 0) {
    throw new Error("QQ official adapter can only send messages with text content in this MVP.");
  }

  return text;
}

function extractMessageId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return stringFromUnknown(value.id) ?? stringFromUnknown(value.message_id);
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

async function defaultFetch(url: string, init?: FetchInitLike): Promise<FetchResponseLike> {
  if (globalThis.fetch === undefined) {
    throw new Error("No fetch implementation is available in this runtime.");
  }

  return globalThis.fetch(url, init) as Promise<FetchResponseLike>;
}

function repeatToLength(source: Buffer, length: number): Buffer {
  if (source.length === 0) {
    throw new Error("QQ official appSecret must not be empty.");
  }

  const result = Buffer.alloc(length);

  for (let index = 0; index < length; index += 1) {
    result[index] = source[index % source.length] ?? 0;
  }

  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable response]";
  }
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    redacted[key] = /(secret|token|password|credential|privatekey|accesskey|apikey)/i.test(key)
      ? "[REDACTED]"
      : redactSensitive(item);
  }

  return redacted;
}

export { textMessage };
