import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo, Server as NetServer } from "node:net";
import { resolve } from "node:path";
import type { Agent, AgentRun } from "@synapse/runtime-agent-core";
import {
  ApiChatAgent,
  createQwenChatProvider,
  OpenAiCompatibleChatProvider,
  type ChatCompletionProvider
} from "@synapse/runtime-agent-api-provider";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import {
  createQqOfficialWebhookValidationResponse,
  QqOfficialChannelAdapter,
  type QqOfficialDispatchPayload,
  type QqOfficialWebhookValidationRequest
} from "@synapse/runtime-channel-qq-official";
import {
  loadConfigFile,
  type AgentProviderConfig,
  type ChannelConfig,
  type LogLevel,
  redactConfig,
  type RuntimeConfig
} from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { getTextContent, textMessage } from "@synapse/runtime-protocol";
import { RuntimeCore } from "@synapse/runtime-core";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import {
  bodyParser,
  createApp,
  type Nova,
  type NovaRequest,
  type NovaResponse
} from "nova-http";

export interface RuntimeServerOptions {
  readonly config: RuntimeConfig;
  readonly awaitDispatch?: boolean;
  readonly fetch?: RuntimeFetch;
  readonly logger?: RuntimeServerLogger;
}

export type RuntimeFetch = (url: string, init?: RuntimeFetchInit) => Promise<RuntimeFetchResponse>;

export interface RuntimeFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface RuntimeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface RuntimeServerLogger {
  debug?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface RuntimeServerStartResult {
  readonly host: string;
  readonly port: number;
}

interface QqOfficialRoute {
  readonly path: string;
  readonly appSecret: string;
  readonly adapter: QqOfficialChannelAdapter;
}

interface QqOfficialSignatureValidationResult {
  readonly ok: boolean;
  readonly reason?: "missing_signature" | "missing_timestamp" | "malformed_signature" | "mismatch";
}

const DEFAULT_LOGGER: RuntimeServerLogger = {
  debug(message, metadata) {
    log("debug", message, metadata);
  },
  info(message, metadata) {
    log("info", message, metadata);
  },
  warn(message, metadata) {
    log("warn", message, metadata);
  },
  error(message, metadata) {
    log("error", message, metadata);
  }
};

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class RuntimeServer {
  readonly #config: RuntimeConfig;
  readonly #logger: RuntimeServerLogger;
  readonly #awaitDispatch: boolean;
  readonly #fetch: RuntimeFetch | undefined;
  readonly #channels = new InMemoryChannelRegistry();
  readonly #app: Nova;
  readonly #qqOfficialRoutes = new Map<string, QqOfficialRoute>();
  readonly #runtime: RuntimeCore;

  constructor(options: RuntimeServerOptions) {
    this.#config = options.config;
    this.#logger = createLevelLogger(options.logger ?? DEFAULT_LOGGER, this.#config.runtime.logLevel);
    this.#awaitDispatch = options.awaitDispatch ?? false;
    this.#fetch = options.fetch;
    this.#app = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });

    const agent = createAgentFromConfig(this.#config, { ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }) });
    const conversation = new ConversationRouter(this.#config.conversation);
    const tools = new ToolRuntime(new StaticPermissionEngine(this.#config.permissions));

    this.#runtime = new RuntimeCore({
      channels: this.#channels,
      conversation,
      agent,
      tools,
      logger: this.#logger
    });
    this.#configureGateway();
  }

  async start(): Promise<RuntimeServerStartResult> {
    this.#logger.info("Starting Synapse Runtime server.", {
      runtimeMode: this.#config.runtime.mode,
      logLevel: this.#config.runtime.logLevel,
      host: this.#config.server.host,
      port: this.#config.server.port,
      awaitDispatch: this.#awaitDispatch,
      enabledChannels: Object.entries(this.#config.channels)
        .filter(([, channel]) => channel.enabled)
        .map(([channelId, channel]) => ({
          channelId,
          adapter: channel.adapter,
          mode: channel.adapter === "qq-official" ? channel.mode : undefined,
          webhookPath: channel.adapter === "qq-official" ? channel.webhookPath : undefined
        }))
    });
    this.#attachChannels();

    for (const channel of this.#channels.list()) {
      this.#logger.info("Connecting channel.", {
        channelId: channel.id,
        channelType: channel.type,
        provider: channel.provider
      });
      await channel.connect();
      this.#logger.info("Channel connected.", {
        channelId: channel.id,
        status: await channel.getStatus()
      });
    }

    await this.#app.listen(this.#config.server.port, this.#config.server.host);

    const address = getNovaServerAddress(this.#app);
    const result =
      typeof address === "object" && address !== null
        ? { host: this.#config.server.host, port: address.port }
        : { host: this.#config.server.host, port: this.#config.server.port };
    this.#logger.info("Synapse Runtime server started.", result);
    return result;
  }

  async stop(): Promise<void> {
    this.#logger.info("Stopping Synapse Runtime server.");
    await this.#app.close();
    await Promise.all(this.#channels.list().map((channel) => channel.disconnect()));
    this.#logger.info("Synapse Runtime server stopped.");
  }

  #configureGateway(): void {
    this.#app.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    this.#app.get("/health", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, { ok: true });
    });
  }

  #attachChannels(): void {
    for (const [channelId, channelConfig] of Object.entries(this.#config.channels)) {
      if (!channelConfig.enabled) {
        this.#logger.info("Skipping disabled channel.", {
          channelId,
          adapter: channelConfig.adapter
        });
        continue;
      }

      this.#logger.info("Attaching channel.", {
        channelId,
        config: redactConfig(summarizeChannelConfig(channelConfig))
      });
      const channel = createChannelAdapter(channelId, channelConfig, { ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }) });
      this.#runtime.attachChannel(channel);
      this.#registerWebhookRoute(channelId, channelConfig, channel);
    }
  }

  #registerWebhookRoute(channelId: string, channelConfig: ChannelConfig, channel: ChannelAdapter): void {
    if (channelConfig.adapter !== "qq-official" || !(channel instanceof QqOfficialChannelAdapter)) {
      return;
    }

    const path = channelConfig.webhookPath ?? `/webhooks/qq-official/${channelId}`;
    const route: QqOfficialRoute = {
      path,
      appSecret: channelConfig.appSecret,
      adapter: channel
    };
    this.#qqOfficialRoutes.set(path, route);
    this.#app.post(path, async (request: NovaRequest, response: NovaResponse) => {
      try {
        await this.#handleQqOfficialWebhook(route, request, response);
      } catch (error) {
        this.#logger.error("Unhandled QQ official webhook error.", {
          channelId,
          path,
          error: error instanceof Error ? error.message : String(error)
        });
        sendJson(response, 500, { ok: false, error: "internal_error" });
      }
    });
    this.#logger.info("Registered QQ official webhook route.", { channelId, path });
  }

  async #handleQqOfficialWebhook(
    route: QqOfficialRoute,
    request: NovaRequest,
    response: NovaResponse
  ): Promise<void> {
    const payload = readJsonBody(request);
    this.#logger.info("Received QQ official webhook.", {
      route: route.path,
      bodySize: request.bodySize,
      contentType: request.getHeader("content-type"),
      signatureTimestampPresent: request.getHeader("x-signature-timestamp") !== undefined,
      signaturePresent: request.getHeader("x-signature-ed25519") !== undefined,
      payload: summarizeQqOfficialPayload(payload)
    });
    const validation = getQqOfficialValidationRequest(payload);

    if (validation !== undefined) {
      this.#logger.info("Handled QQ official webhook validation challenge.", {
        route: route.path,
        eventTs: validation.event_ts,
        plainTokenLength: validation.plain_token.length
      });
      sendJson(response, 200, createQqOfficialWebhookValidationResponse(route.appSecret, validation));
      return;
    }

    const signature = verifyQqOfficialCallbackSignature(route.appSecret, request);

    if (!signature.ok) {
      this.#logger.warn("Rejected QQ official webhook with invalid signature.", {
        route: route.path,
        reason: signature.reason ?? "unknown",
        payload: summarizeQqOfficialPayload(payload)
      });
      sendJson(response, 401, { ok: false, error: "invalid_signature" });
      return;
    }
    this.#logger.info("Accepted QQ official webhook signature.", {
      route: route.path,
      payload: summarizeQqOfficialPayload(payload)
    });

    const dispatch = route.adapter.handlePayload(payload as QqOfficialDispatchPayload);

    if (this.#awaitDispatch) {
      const events = await dispatch;
      this.#logger.info("QQ official webhook dispatch completed.", {
        route: route.path,
        eventCount: events.length,
        events: events.map((event) => ({
          eventId: event.id,
          eventType: event.eventType,
          conversation: event.conversation,
          sender: event.sender,
          messageId: event.message?.id
        }))
      });
      sendJson(response, 200, { op: 12 });
      return;
    }

    dispatch
      .then((events) => {
        this.#logger.info("QQ official webhook dispatch completed.", {
          route: route.path,
          eventCount: events.length,
          events: events.map((event) => ({
            eventId: event.id,
            eventType: event.eventType,
            conversation: event.conversation,
            sender: event.sender,
            messageId: event.message?.id
          }))
        });
      })
      .catch((error) => {
        this.#logger.error("QQ official dispatch failed.", {
          route: route.path,
          payload: summarizeQqOfficialPayload(payload),
          error: error instanceof Error ? error.message : String(error)
        });
      });
    this.#logger.info("Acked QQ official webhook before async dispatch completed.", {
      route: route.path,
      payload: summarizeQqOfficialPayload(payload)
    });
    sendJson(response, 200, { op: 12 });
  }
}

export async function startRuntimeServerFromConfigFile(
  configPath: string,
  options: Omit<RuntimeServerOptions, "config"> = {}
): Promise<RuntimeServer> {
  const config = await loadConfigFile(configPath);
  const server = new RuntimeServer({ ...options, config });
  await server.start();
  return server;
}

export function createAgentFromConfig(
  config: RuntimeConfig,
  options: { readonly fetch?: RuntimeFetch } = {}
): Agent {
  const providerId = config.agent.default;

  if (providerId === undefined) {
    return new EchoAgent({ id: "echo-agent", prefix: "" });
  }

  const providerConfig = config.agent.providers[providerId];

  if (providerConfig === undefined) {
    throw new Error(`Agent provider "${providerId}" is not defined.`);
  }

  if (providerConfig.type === "echo") {
    return new EchoAgent({ id: providerId, prefix: providerConfig.prefix });
  }

  return new ApiChatAgent({
    id: providerId,
    provider: createChatProvider(providerId, providerConfig, options),
    ...(config.agent.systemPrompt === undefined ? {} : { systemPrompt: config.agent.systemPrompt })
  });
}

export function createChatProvider(
  providerId: string,
  providerConfig: AgentProviderConfig,
  options: { readonly fetch?: RuntimeFetch } = {}
): ChatCompletionProvider {
  if (providerConfig.type === "qwen") {
    return createQwenChatProvider({
      id: providerId,
      apiKey: providerConfig.apiKey,
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      ...(providerConfig.temperature === undefined ? {} : { temperature: providerConfig.temperature }),
      ...(providerConfig.maxTokens === undefined ? {} : { maxTokens: providerConfig.maxTokens }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
  }

  if (providerConfig.type === "openai-compatible") {
    return new OpenAiCompatibleChatProvider({
      id: providerId,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      ...(providerConfig.temperature === undefined ? {} : { temperature: providerConfig.temperature }),
      ...(providerConfig.maxTokens === undefined ? {} : { maxTokens: providerConfig.maxTokens }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
  }

  throw new Error(`Agent provider "${providerId}" is not a chat completion provider.`);
}

export function createChannelAdapter(
  channelId: string,
  channelConfig: ChannelConfig,
  options: { readonly fetch?: RuntimeFetch } = {}
): ChannelAdapter {
  if (channelConfig.adapter === "qq-official") {
    return new QqOfficialChannelAdapter({
      id: channelId,
      appId: channelConfig.appId,
      appSecret: channelConfig.appSecret,
      mode: channelConfig.mode,
      ...(channelConfig.apiBaseUrl === undefined ? {} : { apiBaseUrl: channelConfig.apiBaseUrl }),
      ...(channelConfig.tokenEndpoint === undefined ? {} : { tokenEndpoint: channelConfig.tokenEndpoint }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
  }

  throw new Error(`Channel adapter "${channelConfig.adapter}" is not implemented by runtime-server yet.`);
}

export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = readFileSync(resolve(filePath), "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = stripEnvQuotes(line.slice(separator + 1).trim());

    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

class EchoAgent implements Agent {
  readonly id: string;
  readonly #prefix: string;

  constructor(options: { readonly id: string; readonly prefix: string }) {
    this.id = options.id;
    this.#prefix = options.prefix;
  }

  async run(request: Parameters<Agent["run"]>[0]): Promise<AgentRun> {
    const text = `${this.#prefix}${getTextContent(request.input)}`;

    return {
      id: `run-${request.event.id}`,
      agentId: this.id,
      sessionId: request.sessionId,
      status: "succeeded",
      input: request.input,
      steps: [],
      output: textMessage(text)
    };
  }
}

function readJsonBody(request: NovaRequest): unknown {
  if (request.bodySize === 0) {
    return {};
  }

  if (request.bodyParsed !== undefined) {
    return request.bodyParsed;
  }

  return JSON.parse(request.body.toString("utf8")) as unknown;
}

function verifyQqOfficialCallbackSignature(appSecret: string, request: NovaRequest): QqOfficialSignatureValidationResult {
  const signature = request.getHeader("x-signature-ed25519");
  const timestamp = request.getHeader("x-signature-timestamp");

  if (signature === undefined) {
    return { ok: false, reason: "missing_signature" };
  }

  if (timestamp === undefined) {
    return { ok: false, reason: "missing_timestamp" };
  }

  const signatureBytes = Buffer.from(signature, "hex");

  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString("hex") !== signature.toLowerCase() ||
    (signatureBytes[63]! & 224) !== 0
  ) {
    return { ok: false, reason: "malformed_signature" };
  }

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), request.body]);
  const ok = verify(null, message, createQqOfficialPublicKey(appSecret), signatureBytes);

  return ok ? { ok } : { ok, reason: "mismatch" };
}

function createQqOfficialPublicKey(appSecret: string): ReturnType<typeof createPublicKey> {
  const seed = createQqOfficialSeed(appSecret);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });

  return createPublicKey(privateKey);
}

function createQqOfficialSeed(appSecret: string): Buffer {
  if (appSecret.length === 0) {
    throw new Error("QQ official appSecret must not be empty.");
  }

  let seed = appSecret;

  while (Buffer.byteLength(seed, "utf8") < 32) {
    seed += seed;
  }

  return Buffer.from(seed, "utf8").subarray(0, 32);
}

function isQqOfficialValidationRequest(value: unknown): value is QqOfficialWebhookValidationRequest {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.plain_token === "string" && typeof value.event_ts === "string";
}

function getQqOfficialValidationRequest(payload: unknown): QqOfficialWebhookValidationRequest | undefined {
  if (isQqOfficialValidationRequest(payload)) {
    return payload;
  }

  if (!isRecord(payload) || payload.op !== 13 || !isQqOfficialValidationRequest(payload.d)) {
    return undefined;
  }

  return payload.d;
}

function sendJson(response: NovaResponse, statusCode: number, body: unknown): void {
  response.status(statusCode).setHeader("content-type", "application/json; charset=utf-8").json(body);
}

function getNovaServerAddress(app: Nova): AddressInfo | string | null {
  const server = (app as unknown as { readonly _server: NetServer | null })._server;
  return server?.address() ?? null;
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function summarizeChannelConfig(channel: ChannelConfig): Readonly<Record<string, unknown>> {
  if (channel.adapter === "qq-official") {
    return {
      adapter: channel.adapter,
      appId: channel.appId,
      appSecret: channel.appSecret,
      mode: channel.mode,
      apiBaseUrl: channel.apiBaseUrl,
      tokenEndpoint: channel.tokenEndpoint,
      webhookPath: channel.webhookPath,
      enabled: channel.enabled,
      riskLevel: channel.riskLevel
    };
  }

  return {
    adapter: channel.adapter,
    provider: channel.provider,
    transport: channel.transport,
    endpoint: channel.endpoint,
    accessToken: channel.accessToken,
    enabled: channel.enabled,
    riskLevel: channel.riskLevel
  };
}

function summarizeQqOfficialPayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(payload)) {
    return { shape: typeof payload };
  }

  const data = isRecord(payload.d) ? payload.d : undefined;
  return {
    op: payload.op,
    t: payload.t,
    id: payload.id,
    dataKeys: data === undefined ? undefined : Object.keys(data).sort(),
    messageId: data?.msg_id ?? data?.id,
    eventId: data?.event_id,
    groupOpenid: data?.group_openid,
    groupId: data?.group_id,
    userOpenid: data?.user_openid ?? (isRecord(data?.author) ? data.author.user_openid : undefined),
    channelId: data?.channel_id,
    guildId: data?.guild_id,
    contentLength: typeof data?.content === "string" ? data.content.length : undefined,
    contentPreview: typeof data?.content === "string" ? previewText(data.content) : undefined
  };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function createLevelLogger(logger: RuntimeServerLogger, logLevel: LogLevel): RuntimeServerLogger {
  const threshold = LOG_LEVEL_ORDER[logLevel];

  return {
    debug(message, metadata) {
      if (LOG_LEVEL_ORDER.debug >= threshold) {
        logger.debug?.(message, redactConfig(metadata));
      }
    },
    info(message, metadata) {
      if (LOG_LEVEL_ORDER.info >= threshold) {
        logger.info(message, redactConfig(metadata));
      }
    },
    warn(message, metadata) {
      if (LOG_LEVEL_ORDER.warn >= threshold) {
        logger.warn(message, redactConfig(metadata));
      }
    },
    error(message, metadata) {
      if (LOG_LEVEL_ORDER.error >= threshold) {
        logger.error(message, redactConfig(metadata));
      }
    }
  };
}

const LOG_LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
} as const satisfies Record<LogLevel, number>;

function log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(metadata === undefined ? {} : { metadata })
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}
