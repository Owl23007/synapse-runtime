import { join } from "node:path";
import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "@synapse/runtime-channel-qq-official";
import {
  loadConfigFile,
  redactConfig,
  type AdminSettings,
  type ChannelConfig,
  type RuntimeConfig
} from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { RuntimeCore, SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { bodyParser, createApp, type Handler, type Nova, type NovaRequest, type NovaResponse } from "nova-http";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import { createChannelAdapter } from "../composition/channel-factory.js";
import { DEFAULT_LOGGER, RuntimeLogBuffer, createLevelLogger, createTeeLogger } from "../logging.js";
import type {
  RuntimeFetch,
  RuntimeLogEntry,
  RuntimeServerLogger,
  RuntimeServerOptions,
  RuntimeServerStartResult
} from "../types.js";
import { getNovaServerAddress, readJsonBody, sendJson } from "./http.js";
import { handleQqOfficialWebhook, type QqOfficialRoute } from "./qq-official-webhook.js";
import { summarizeChannelConfig } from "./summaries.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const NOVA_HEADERS_SENT_KEY = "_headersSent";

export class RuntimeServer {
  #config: RuntimeConfig;
  readonly #configPath: string | undefined;
  readonly #logger: RuntimeServerLogger;
  readonly #awaitDispatch: boolean;
  readonly #fetch: RuntimeFetch | undefined;
  readonly #channels = new InMemoryChannelRegistry();
  readonly #app: Nova;
  readonly #adminApp: Nova;
  readonly #logBuffer: RuntimeLogBuffer;
  readonly #qqOfficialRoutes = new Map<string, QqOfficialRoute>();
  readonly #registeredWebhookPaths = new Set<string>();
  #runtime: RuntimeCore;
  #contextStore: SqliteRuntimeContextStore | undefined;
  readonly #startedAt = new Date().toISOString();

  constructor(options: RuntimeServerOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#logBuffer = new RuntimeLogBuffer(this.#config.admin.logBufferSize);
    this.#logger = createLevelLogger(
      createTeeLogger([this.#logBuffer, options.logger ?? DEFAULT_LOGGER]),
      this.#config.runtime.logLevel
    );
    this.#awaitDispatch = options.awaitDispatch ?? false;
    this.#fetch = options.fetch;
    this.#app = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });
    this.#adminApp = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });

    this.#runtime = this.#createRuntime(this.#config);
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

    await Promise.all(
      this.#channels.list().map(async (channel) => {
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
      })
    );

    await this.#app.listen(this.#config.server.port, this.#config.server.host);
    const adminResult = await this.#startAdminApp();

    const address = getNovaServerAddress(this.#app);
    const result: RuntimeServerStartResult =
      typeof address === "object" && address !== null
        ? {
            host: this.#config.server.host,
            port: address.port,
            ...(adminResult === undefined ? {} : { admin: adminResult })
          }
        : {
            host: this.#config.server.host,
            port: this.#config.server.port,
            ...(adminResult === undefined ? {} : { admin: adminResult })
          };
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
    this.#closeContextStore();
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
    this.#adminApp.get(
      "/admin/status",
      this.#asyncRoute(async (_request: NovaRequest, response: NovaResponse) => {
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
      })
    );
    this.#adminApp.get("/admin/config", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, {
        ok: true,
        config: redactConfig(this.#config)
      });
    });
    this.#adminApp.get(
      "/admin/channels",
      this.#asyncRoute(async (_request: NovaRequest, response: NovaResponse) => {
        sendJson(response, 200, {
          ok: true,
          channels: await this.#getAdminChannelSummaries()
        });
      })
    );
    this.#adminApp.patch(
      "/admin/channels/:id",
      this.#asyncRoute(async (request: NovaRequest, response: NovaResponse) => {
        const channelId = request.params.id;

        if (channelId === undefined) {
          sendJson(response, 400, { ok: false, error: "missing_channel_id" });
          return;
        }

        const channelConfig = this.#config.channels[channelId];

        if (channelConfig === undefined) {
          sendJson(response, 404, { ok: false, error: "channel_not_found" });
          return;
        }

        const patch = readJsonBody(request);
        if (!isChannelAdminPatch(patch)) {
          sendJson(response, 400, { ok: false, error: "invalid_channel_patch" });
          return;
        }

        try {
          await this.#applyChannelPatch(channelId, channelConfig, patch);
          const nextChannelConfig = this.#config.channels[channelId] ?? channelConfig;
          sendJson(response, 200, {
            ok: true,
            channel: await this.#getAdminChannelSummary(channelId, nextChannelConfig)
          });
        } catch (error) {
          this.#logger.error("Admin channel patch failed.", {
            channelId,
            error: error instanceof Error ? error.message : String(error)
          });
          sendJson(response, 500, { ok: false, error: "channel_patch_failed" });
        }
      })
    );
    this.#adminApp.get("/admin/logs", (request: NovaRequest, response: NovaResponse) => {
      const limit = parsePositiveInt(request.query.get("limit")) ?? 100;
      sendJson(response, 200, {
        ok: true,
        logs: this.#logBuffer.entries.slice(-limit)
      });
    });
    this.#adminApp.get("/admin/events/stream", (_request: NovaRequest, response: NovaResponse) =>
      streamLogEvents(response, this.#logBuffer)
    );
    this.#adminApp.post(
      "/admin/reload",
      this.#asyncRoute(async (_request: NovaRequest, response: NovaResponse) => {
        if (this.#configPath === undefined) {
          sendJson(response, 400, { ok: false, error: "reload_config_path_not_available" });
          return;
        }

        try {
          await this.#reloadConfig();
          sendJson(response, 200, {
            ok: true,
            config: redactConfig(this.#config),
            channels: await this.#getAdminChannelSummaries()
          });
        } catch (error) {
          this.#logger.error("Admin reload failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
          sendJson(response, 500, { ok: false, error: "reload_failed" });
        }
      })
    );
    this.#adminApp.post("/admin/shutdown", (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 202, { ok: true });

      // 先写出响应，再异步关闭服务，避免客户端在响应发送前连接被切断。
      setTimeout(() => {
        this.stop().catch((error) => {
          this.#logger.error("Admin shutdown failed.", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, 0);
    });
  }

  #asyncRoute(handler: Handler): Handler {
    return (request, response) => {
      void Promise.resolve(handler(request, response)).catch((error) => {
        this.#logger.error("HTTP route handler failed.", {
          error: error instanceof Error ? error.message : String(error)
        });

        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "internal_error" });
        }
      });
    };
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
      Object.entries(this.#config.channels).map(([channelId, channelConfig]) =>
        this.#getAdminChannelSummary(channelId, channelConfig)
      )
    );

    return channels;
  }

  async #getAdminChannelSummary(channelId: string, channelConfig: ChannelConfig): Promise<unknown> {
    const adapter = this.#channels.get(channelId);
    return {
      id: channelId,
      adapter: channelConfig.adapter,
      enabled: channelConfig.enabled,
      provider: channelConfig.adapter === "onebot11" ? channelConfig.provider : "qq-official",
      status:
        adapter === undefined
          ? { state: channelConfig.enabled ? "offline" : "disabled", checkedAt: new Date(0).toISOString() }
          : await adapter.getStatus()
    };
  }

  async #reloadConfig(): Promise<void> {
    if (this.#configPath === undefined) {
      throw new Error("Runtime server was not started from a config file.");
    }

    const nextConfig = await loadConfigFile(this.#configPath);
    validateAdminSecurity(nextConfig.admin);
    await this.#replaceRuntimeConfig(nextConfig);
    this.#logger.info("Admin reloaded runtime config.", {
      configPath: this.#configPath,
      enabledChannels: Object.entries(nextConfig.channels)
        .filter(([, channel]) => channel.enabled)
        .map(([channelId, channel]) => ({ channelId, adapter: channel.adapter }))
    });
  }

  async #replaceRuntimeConfig(nextConfig: RuntimeConfig): Promise<void> {
    await this.#disconnectAllChannels();
    this.#closeContextStore();
    this.#config = nextConfig;
    this.#runtime = this.#createRuntime(nextConfig);
    this.#qqOfficialRoutes.clear();
    this.#attachChannels();

    await Promise.all(this.#channels.list().map((channel) => channel.connect()));
  }

  async #disconnectAllChannels(): Promise<void> {
    const channels = this.#channels.list();

    for (const channel of channels) {
      this.#channels.unregister(channel.id);
    }

    await Promise.all(channels.map((channel) => channel.disconnect()));
  }

  #createRuntime(config: RuntimeConfig): RuntimeCore {
    const agent = createAgentFromConfig(config, { ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }) });
    const conversation = new ConversationRouter(config.conversation);
    const tools = new ToolRuntime(new StaticPermissionEngine(config.permissions));
    const contextStore = config.context.enabled
      ? new SqliteRuntimeContextStore({ databasePath: join(config.runtime.dataDir, "runtime-context.sqlite") })
      : undefined;
    this.#contextStore = contextStore;

    return new RuntimeCore({
      channels: this.#channels,
      conversation,
      agent,
      tools,
      logger: this.#logger,
      memory: {
        enableDurableMemory: durableMemoryEnabled(config)
      },
      context: {
        enabled: config.context.enabled,
        maxHistoryChars: config.context.maxHistoryChars,
        timezone: config.context.timezone,
        privateHistoryTtlMinutes: config.context.privateHistoryTtlMinutes,
        groupHistoryTtlMinutes: config.context.groupHistoryTtlMinutes,
        channelHistoryTtlMinutes: config.context.channelHistoryTtlMinutes,
        privateMaxMessages: config.context.privateMaxMessages,
        groupMaxMessages: config.context.groupMaxMessages,
        channelMaxMessages: config.context.channelMaxMessages,
        providerByChannelId: providerByChannelId(config.channels),
        ...(contextStore === undefined
          ? {}
          : {
              transcriptStore: contextStore,
              eventProcessStore: contextStore
            })
      }
    });
  }

  #closeContextStore(): void {
    this.#contextStore?.close();
    this.#contextStore = undefined;
  }

  async #applyChannelPatch(channelId: string, channelConfig: ChannelConfig, patch: ChannelAdminPatch): Promise<void> {
    if (patch.enabled === undefined || patch.enabled === channelConfig.enabled) {
      return;
    }

    if (patch.enabled) {
      await this.#enableChannel(channelId, { ...channelConfig, enabled: true } as ChannelConfig);
      return;
    }

    await this.#disableChannel(channelId, { ...channelConfig, enabled: false } as ChannelConfig);
  }

  async #enableChannel(channelId: string, channelConfig: ChannelConfig): Promise<void> {
    if (this.#channels.get(channelId) !== undefined) {
      this.#config = updateChannelConfig(this.#config, channelId, channelConfig);
      return;
    }

    const channel = createChannelAdapter(channelId, channelConfig, {
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
    this.#runtime.attachChannel(channel);
    this.#registerWebhookRoute(channelId, channelConfig, channel);
    await channel.connect();
    this.#config = updateChannelConfig(this.#config, channelId, channelConfig);
    this.#logger.info("Admin enabled channel.", {
      channelId,
      adapter: channelConfig.adapter,
      status: await channel.getStatus()
    });
  }

  async #disableChannel(channelId: string, channelConfig: ChannelConfig): Promise<void> {
    const channel = this.#channels.unregister(channelId);

    if (channel !== undefined) {
      await channel.disconnect();
    }

    this.#removeWebhookRoute(channelId, channelConfig);
    this.#config = updateChannelConfig(this.#config, channelId, channelConfig);
    this.#logger.info("Admin disabled channel.", {
      channelId,
      adapter: channelConfig.adapter
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
      const channel = createChannelAdapter(channelId, channelConfig, {
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
      });
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
    if (this.#registeredWebhookPaths.has(path)) {
      return;
    }

    this.#registeredWebhookPaths.add(path);
    this.#app.post(
      path,
      this.#asyncRoute(async (request: NovaRequest, response: NovaResponse) => {
        const activeRoute = this.#qqOfficialRoutes.get(path);

        if (activeRoute === undefined) {
          sendJson(response, 404, { ok: false, error: "channel_route_disabled" });
          return;
        }

        try {
          await handleQqOfficialWebhook({
            route: activeRoute,
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
      })
    );
    this.#logger.info("Registered QQ official webhook route.", { channelId, path });
  }

  #removeWebhookRoute(channelId: string, channelConfig: ChannelConfig): void {
    if (channelConfig.adapter !== "qq-official") {
      return;
    }

    const path = channelConfig.webhookPath ?? `/webhooks/qq-official/${channelId}`;
    this.#qqOfficialRoutes.delete(path);
  }
}

interface ChannelAdminPatch {
  readonly enabled?: boolean;
}

function isChannelAdminPatch(value: unknown): value is ChannelAdminPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Readonly<Record<string, unknown>>;
  return record.enabled === undefined || typeof record.enabled === "boolean";
}

function updateChannelConfig(config: RuntimeConfig, channelId: string, channelConfig: ChannelConfig): RuntimeConfig {
  return {
    ...config,
    channels: {
      ...config.channels,
      [channelId]: channelConfig
    }
  };
}

function providerByChannelId(channels: RuntimeConfig["channels"]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(channels).map(([channelId, channel]) => [channelId, channelProvider(channel)])
  );
}

function channelProvider(channel: ChannelConfig): string {
  if (channel.adapter === "onebot11") {
    return channel.provider;
  }

  return "qq-official";
}

function durableMemoryEnabled(config: RuntimeConfig): boolean {
  const memory = (config as { readonly memory?: unknown }).memory;

  if (typeof memory !== "object" || memory === null || !("enableDurableMemory" in memory)) {
    return false;
  }

  return (memory as { readonly enableDurableMemory?: unknown }).enableDurableMemory === true;
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

function streamLogEvents(response: NovaResponse, logBuffer: RuntimeLogBuffer): Promise<void> {
  const socket = response.socket;
  const responseState = response as unknown as Record<typeof NOVA_HEADERS_SENT_KEY, boolean>;
  responseState[NOVA_HEADERS_SENT_KEY] = true;

  socket.write(
    [
      "HTTP/1.1 200 OK",
      "content-type: text/event-stream; charset=utf-8",
      "cache-control: no-cache, no-transform",
      "connection: keep-alive",
      "x-accel-buffering: no",
      "",
      ": connected",
      "",
      ""
    ].join("\r\n")
  );

  for (const entry of logBuffer.entries) {
    writeSseLogEntry(socket, entry);
  }

  const unsubscribe = logBuffer.subscribe((entry) => {
    writeSseLogEntry(socket, entry);
  });

  return new Promise((resolve) => {
    socket.once("close", () => {
      unsubscribe();
      resolve();
    });
  });
}

function writeSseLogEntry(socket: NovaResponse["socket"], entry: RuntimeLogEntry): void {
  if (socket.destroyed) {
    return;
  }

  socket.write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
}

export async function startRuntimeServerFromConfigFile(
  configPath: string,
  options: Omit<RuntimeServerOptions, "config"> = {}
): Promise<RuntimeServer> {
  const config = await loadConfigFile(configPath);
  const server = new RuntimeServer({ ...options, config, configPath });
  await server.start();
  return server;
}
