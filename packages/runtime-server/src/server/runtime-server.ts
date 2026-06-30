import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "@synapse/runtime-channel-qq-official";
import { loadConfigFile, redactConfig, type AdminSettings, type ChannelConfig } from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { RuntimeCore } from "@synapse/runtime-core";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { bodyParser, createApp, type Nova, type NovaRequest, type NovaResponse } from "nova-http";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import { createChannelAdapter } from "../composition/channel-factory.js";
import { DEFAULT_LOGGER, RuntimeLogBuffer, createLevelLogger, createTeeLogger } from "../logging.js";
import type { RuntimeFetch, RuntimeServerLogger, RuntimeServerOptions, RuntimeServerStartResult } from "../types.js";
import { getNovaServerAddress, sendJson } from "./http.js";
import { handleQqOfficialWebhook, type QqOfficialRoute } from "./qq-official-webhook.js";
import { summarizeChannelConfig } from "./summaries.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class RuntimeServer {
  readonly #config: RuntimeServerOptions["config"];
  readonly #logger: RuntimeServerLogger;
  readonly #awaitDispatch: boolean;
  readonly #fetch: RuntimeFetch | undefined;
  readonly #channels = new InMemoryChannelRegistry();
  readonly #app: Nova;
  readonly #adminApp: Nova;
  readonly #logBuffer: RuntimeLogBuffer;
  readonly #qqOfficialRoutes = new Map<string, QqOfficialRoute>();
  readonly #runtime: RuntimeCore;
  readonly #startedAt = new Date().toISOString();

  constructor(options: RuntimeServerOptions) {
    this.#config = options.config;
    this.#logBuffer = new RuntimeLogBuffer(this.#config.admin.logBufferSize);
    this.#logger = createLevelLogger(
      createTeeLogger([this.#logBuffer, options.logger ?? DEFAULT_LOGGER]),
      this.#config.runtime.logLevel
    );
    this.#awaitDispatch = options.awaitDispatch ?? false;
    this.#fetch = options.fetch;
    this.#app = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });
    this.#adminApp = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });

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
    this.#configureAdmin();
  }

  async start(): Promise<RuntimeServerStartResult> {
    validateAdminSecurity(this.#config.admin);
    this.#logger.info("Starting Synapse Runtime server.", {
      runtimeMode: this.#config.runtime.mode,
      logLevel: this.#config.runtime.logLevel,
      host: this.#config.server.host,
      port: this.#config.server.port,
      adminEnabled: this.#config.admin.enabled,
      adminHost: this.#config.admin.enabled ? this.#config.admin.host : undefined,
      adminPort: this.#config.admin.enabled ? this.#config.admin.port : undefined,
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
    const adminResult = await this.#startAdminApp();

    const address = getNovaServerAddress(this.#app);
    const result: RuntimeServerStartResult =
      typeof address === "object" && address !== null
        ? { host: this.#config.server.host, port: address.port, ...(adminResult === undefined ? {} : { admin: adminResult }) }
        : { host: this.#config.server.host, port: this.#config.server.port, ...(adminResult === undefined ? {} : { admin: adminResult }) };
    this.#logger.info("Synapse Runtime server started.", { ...result });
    return result;
  }

  async stop(): Promise<void> {
    this.#logger.info("Stopping Synapse Runtime server.");
    await this.#app.close();
    if (this.#config.admin.enabled) {
      await this.#adminApp.close();
    }
    await Promise.all(this.#channels.list().map((channel) => channel.disconnect()));
    this.#logger.info("Synapse Runtime server stopped.");
  }

  #configureGateway(): void {
    this.#app.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    this.#app.get("/health", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, { ok: true });
    });
  }

  #configureAdmin(): void {
    this.#adminApp.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    this.#adminApp.use("/admin", (request: NovaRequest, response: NovaResponse, next: () => void) => {
      if (!this.#authorizeAdminRequest(request, response)) {
        return;
      }

      next();
    });
    this.#adminApp.get("/admin/health", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, { ok: true });
    });
    this.#adminApp.get("/admin/status", async (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: 1,
        runtime: {
          mode: this.#config.runtime.mode,
          logLevel: this.#config.runtime.logLevel,
          startedAt: this.#startedAt
        },
        server: {
          host: this.#config.server.host,
          port: this.#config.server.port
        },
        admin: {
          host: this.#config.admin.host,
          port: this.#config.admin.port
        },
        channels: await this.#getAdminChannelSummaries()
      });
    });
    this.#adminApp.get("/admin/config", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, {
        ok: true,
        config: redactConfig(this.#config)
      });
    });
    this.#adminApp.get("/admin/channels", async (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, {
        ok: true,
        channels: await this.#getAdminChannelSummaries()
      });
    });
    this.#adminApp.get("/admin/logs", (request: NovaRequest, response: NovaResponse) => {
      const limit = parsePositiveInt(request.query.get("limit")) ?? 100;
      sendJson(response, 200, {
        ok: true,
        logs: this.#logBuffer.entries.slice(-limit)
      });
    });
  }

  async #startAdminApp(): Promise<RuntimeServerStartResult["admin"] | undefined> {
    if (!this.#config.admin.enabled) {
      return undefined;
    }

    await this.#adminApp.listen(this.#config.admin.port, this.#config.admin.host);
    const address = getNovaServerAddress(this.#adminApp);
    const result =
      typeof address === "object" && address !== null
        ? { host: this.#config.admin.host, port: address.port }
        : { host: this.#config.admin.host, port: this.#config.admin.port };
    this.#logger.info("Synapse Runtime admin API started.", result);
    return result;
  }

  #authorizeAdminRequest(request: NovaRequest, response: NovaResponse): boolean {
    const origin = request.getHeader("origin");

    if (origin !== undefined && !this.#config.admin.allowedOrigins.includes(origin)) {
      sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
      return false;
    }

    if (!this.#config.admin.allowedRemoteAddresses.includes(request.ip)) {
      sendJson(response, 403, { ok: false, error: "remote_address_not_allowed" });
      return false;
    }

    if (this.#config.admin.token === undefined) {
      return true;
    }

    if (request.getHeader("authorization") !== `Bearer ${this.#config.admin.token}`) {
      sendJson(response, 401, { ok: false, error: "invalid_admin_token" });
      return false;
    }

    return true;
  }

  async #getAdminChannelSummaries(): Promise<unknown[]> {
    const channels = await Promise.all(
      Object.entries(this.#config.channels).map(async ([channelId, channelConfig]) => {
        const adapter = this.#channels.get(channelId);
        return {
          id: channelId,
          adapter: channelConfig.adapter,
          enabled: channelConfig.enabled,
          provider: channelConfig.adapter === "onebot11" ? channelConfig.provider : "qq-official",
          status: adapter === undefined
            ? { state: channelConfig.enabled ? "offline" : "disabled", checkedAt: new Date(0).toISOString() }
            : await adapter.getStatus()
        };
      })
    );

    return channels;
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
        await handleQqOfficialWebhook({
          route,
          request,
          response,
          awaitDispatch: this.#awaitDispatch,
          logger: this.#logger
        });
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
}

function validateAdminSecurity(admin: AdminSettings): void {
  if (!admin.enabled || isLoopbackHost(admin.host)) {
    return;
  }

  // 远程 Admin API 必须显式配置 token，避免误把控制面暴露到公网。
  if (admin.token === undefined) {
    throw new Error("Remote admin API requires admin.token. Keep admin.host on 127.0.0.1 for local development.");
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
