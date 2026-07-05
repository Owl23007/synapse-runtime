import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { loadConfigFile, type RuntimeConfig } from "@synapse/runtime-config";
import { RuntimeCore, SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { bodyParser, createApp, type Nova } from "nova-http";
import { DEFAULT_LOGGER, RuntimeLogBuffer, createLevelLogger, createTeeLogger } from "../logging.js";
import type { RuntimeFetch, RuntimeServerLogger, RuntimeServerOptions, RuntimeServerStartResult } from "../types.js";
import { validateAdminSecurity } from "./admin/auth.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { RuntimeChannelManager } from "./channel-manager.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { serverStartResult, startAdminApp } from "./runtime-lifecycle.js";
import { createRuntimeFromConfig } from "./runtime-factory.js";
import { QqOfficialWebhookRegistry } from "./webhook-registry.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

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
  readonly #webhookRegistry: QqOfficialWebhookRegistry;
  readonly #channelManager: RuntimeChannelManager;
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
    this.#webhookRegistry = new QqOfficialWebhookRegistry({
      app: this.#app,
      awaitDispatch: this.#awaitDispatch,
      logger: this.#logger
    });

    const runtimeResult = createRuntimeFromConfig({
      config: this.#config,
      channels: this.#channels,
      logger: this.#logger,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
    this.#runtime = runtimeResult.runtime;
    this.#contextStore = runtimeResult.contextStore;
    this.#channelManager = new RuntimeChannelManager({
      channels: this.#channels,
      webhookRegistry: this.#webhookRegistry,
      logger: this.#logger,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      getRuntime: () => this.#runtime,
      getConfig: () => this.#config,
      setConfig: (config) => {
        this.#config = config;
      }
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
    this.#channelManager.attachEnabledChannels(this.#config);
    await this.#channelManager.connectAll();

    await this.#app.listen(this.#config.server.port, this.#config.server.host);
    const adminResult = await startAdminApp({
      app: this.#adminApp,
      config: this.#config,
      logger: this.#logger
    });
    const result = serverStartResult({ app: this.#app, config: this.#config, admin: adminResult });
    this.#logger.info("Synapse Runtime server started.", { ...result });
    return result;
  }

  async stop(): Promise<void> {
    this.#logger.info("Stopping Synapse Runtime server.");
    await this.#app.close();
    if (this.#config.admin.enabled) {
      await this.#adminApp.close();
    }
    await this.#channelManager.disconnectAll();
    this.#closeContextStore();
    this.#logger.info("Synapse Runtime server stopped.");
  }

  #configureGateway(): void {
    this.#app.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    registerGatewayRoutes(this.#app);
  }

  #configureAdmin(): void {
    this.#adminApp.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    registerAdminRoutes({
      app: this.#adminApp,
      getConfig: () => this.#config,
      getConfigPath: () => this.#configPath,
      getStartedAt: () => this.#startedAt,
      logBuffer: this.#logBuffer,
      logger: this.#logger,
      getChannelSummaries: () => this.#channelManager.getAdminChannelSummaries(),
      getChannelSummary: (channelId, channelConfig) =>
        this.#channelManager.getAdminChannelSummary(channelId, channelConfig),
      applyChannelPatch: (channelId, channelConfig, patch) =>
        this.#channelManager.applyChannelPatch(channelId, channelConfig, patch),
      reloadConfig: () => this.#reloadConfig(),
      shutdown: () => this.stop()
    });
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
    await this.#channelManager.disconnectAll();
    this.#closeContextStore();
    this.#config = nextConfig;
    const runtimeResult = createRuntimeFromConfig({
      config: nextConfig,
      channels: this.#channels,
      logger: this.#logger,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
    this.#runtime = runtimeResult.runtime;
    this.#contextStore = runtimeResult.contextStore;
    this.#webhookRegistry.clear();
    this.#channelManager.attachEnabledChannels(this.#config);

    await Promise.all(this.#channels.list().map((channel) => channel.connect()));
  }

  #closeContextStore(): void {
    this.#contextStore?.close();
    this.#contextStore = undefined;
  }
}

export { startRuntimeServerFromConfigFile } from "./runtime-server-from-config.js";
