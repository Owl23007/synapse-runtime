import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { loadConfigFile, type RuntimeConfig } from "../config/index.js";
import { bodyParser, createApp, type Nova } from "nova-http";
import { DEFAULT_LOGGER, RuntimeLogBuffer, createLevelLogger, createTeeLogger } from "../logging.js";
import type { RuntimeFetch, RuntimeServerLogger, RuntimeServerOptions, RuntimeServerStartResult } from "../types.js";
import { validateAdminSecurity } from "./admin/auth.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerWebUi } from "./admin/webui.js";
import { RuntimeChannelManager } from "./channel-manager.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { serverStartResult, startAdminApp } from "./runtime-lifecycle.js";
import { createRuntimeAssembly, type RuntimeAssembly } from "../composition/runtime-assembly.js";
import { QqOfficialWebhookRegistry } from "./webhook-registry.js";
import { validateReloadConfig } from "./reload-policy.js";
import { collectTraceSecrets } from "../secrets.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** 管理运行时、频道以及网关和管理监听器的完整生命周期 */
export class RuntimeServer {
  #config: RuntimeConfig;
  readonly #loadConfigOptions: RuntimeServerOptions["loadConfigOptions"];
  readonly #configPath: string | undefined;
  readonly #logger: RuntimeServerLogger;
  readonly #logSecrets = new Set<string>();
  readonly #awaitDispatch: boolean;
  readonly #fetch: RuntimeFetch | undefined;
  readonly #channels = new InMemoryChannelRegistry();
  readonly #app: Nova;
  readonly #adminApp: Nova;
  readonly #logBuffer: RuntimeLogBuffer;
  readonly #webhookRegistry: QqOfficialWebhookRegistry;
  readonly #channelManager: RuntimeChannelManager;
  readonly #shutdownController = new AbortController();
  #assembly: RuntimeAssembly;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #startPromise: Promise<RuntimeServerStartResult> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopped = false;
  #listening: RuntimeServerStartResult | undefined;
  readonly #startedAt = new Date().toISOString();

  constructor(options: RuntimeServerOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#loadConfigOptions = options.loadConfigOptions;
    this.#logBuffer = new RuntimeLogBuffer(this.#config.admin.logBufferSize);
    this.#logger = createLevelLogger(
      createTeeLogger([this.#logBuffer, options.logger ?? DEFAULT_LOGGER]),
      this.#config.runtime.logLevel,
      () => {
        // 热更新后的迟到错误仍可能携带旧凭据，进程存活期间保留旧值用于脱敏
        for (const secret of collectTraceSecrets(this.#config)) this.#logSecrets.add(secret);
        return [...this.#logSecrets].sort((a, b) => b.length - a.length);
      }
    );
    this.#awaitDispatch = options.awaitDispatch ?? false;
    this.#fetch = options.fetch;
    this.#app = createApp({ maxBodySize: MAX_JSON_BODY_BYTES });
    this.#adminApp = createApp({ maxBodySize: MAX_JSON_BODY_BYTES, requestTimeout: 0 });
    this.#webhookRegistry = new QqOfficialWebhookRegistry({
      app: this.#app,
      awaitDispatch: this.#awaitDispatch,
      logger: this.#logger
    });

    this.#channelManager = new RuntimeChannelManager({
      channels: this.#channels,
      webhookRegistry: this.#webhookRegistry,
      logger: this.#logger,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      getRuntime: () => this.#assembly.runtime,
      getConfig: () => this.#config,
      setConfig: (config) => {
        this.#config = config;
      }
    });

    this.#configureGateway();
    this.#configureAdmin();
    this.#assembly = createRuntimeAssembly({
      config: this.#config,
      channels: this.#channels,
      logger: this.#logger,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
  }

  start(): Promise<RuntimeServerStartResult> {
    if (this.#stopPromise !== undefined) {
      return Promise.reject(new Error("Runtime server is shutting down and cannot be started."));
    }
    this.#startPromise ??= this.#enqueueLifecycle(() => this.#performStart());
    return this.#startPromise;
  }

  async #performStart(): Promise<RuntimeServerStartResult> {
    if (this.#stopped) {
      throw new Error("Runtime server has already stopped and cannot be started.");
    }

    try {
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
      const recovery = await this.#assembly.taskRunner.recover();
      if (recovery.resumedTaskIds.length > 0 || recovery.failedTaskIds.length > 0) {
        this.#logger.warn("Recovered persisted branch tasks.", { ...recovery });
      }

      await this.#app.listen(this.#config.server.port, this.#config.server.host);
      const adminResult = await startAdminApp({
        app: this.#adminApp,
        config: this.#config,
        logger: this.#logger
      });
      const result = serverStartResult({ app: this.#app, config: this.#config, admin: adminResult });
      this.#listening = result;
      this.#logger.info("Synapse Runtime server started.", { ...result });
      return result;
    } catch (error) {
      await this.#performStop();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#enqueueLifecycle(() => this.#performStop());
    return this.#stopPromise;
  }

  async #performStop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#logger.info("Stopping Synapse Runtime server.");
    this.#webhookRegistry.pause();
    this.#shutdownController.abort();
    const runtimeShutdown = this.#assembly.quiesce();
    await this.#cleanupStep("close gateway listener", () => this.#app.close());
    await this.#cleanupStep("close admin listener", () => this.#adminApp.close());
    this.#webhookRegistry.clear();
    await this.#cleanupStep("drain webhook dispatch", () => this.#webhookRegistry.drain());
    await this.#cleanupStep("drain runtime operations", () => runtimeShutdown);
    await this.#cleanupStep("disconnect channels", () => this.#channelManager.disconnectAll());
    await this.#cleanupStep("dispose runtime assembly", () => this.#assembly.dispose());
    this.#logger.info("Synapse Runtime server stopped.");
  }

  #configureGateway(): void {
    this.#app.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    registerGatewayRoutes(this.#app);
  }

  #configureAdmin(): void {
    registerWebUi(this.#adminApp);
    this.#adminApp.use(bodyParser({ maxSize: MAX_JSON_BODY_BYTES, types: ["json"] }));
    registerAdminRoutes({
      getExecutionStatus: () => this.#assembly.runtime.executionStatus,
      getListening: () => this.#listening,
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
      shutdown: () => this.stop(),
      shutdownSignal: this.#shutdownController.signal,
      listBranches: async (sessionId) =>
        sessionId === undefined
          ? (await this.#assembly.runtime.conversationStore.getRecoveryState()).activeBranches
          : this.#assembly.runtime.conversationStore.listBranches(sessionId),
      getBranch: (branchId) => this.#assembly.runtime.conversationStore.getBranch(branchId),
      listTasks: async (branchId) =>
        branchId === undefined
          ? (await this.#assembly.runtime.conversationStore.getRecoveryState()).unfinishedTasks
          : this.#assembly.runtime.conversationStore.listTasks(branchId),
      getTask: (taskId) => this.#assembly.runtime.conversationStore.getTask(taskId),
      cancelTask: (taskId) => this.#assembly.taskRunner.cancel(taskId),
      getMemoryStore: () => (this.#assembly.closed ? undefined : this.#assembly.contextStore),
      getContextStore: () => (this.#assembly.closed ? undefined : this.#assembly.contextStore),
      localize: (key, params) => this.#assembly.localeResolver.resolve(key, params, this.#config.locale.default)
    });
  }

  #reloadConfig(): Promise<void> {
    return this.#enqueueLifecycle(async () => {
      if (this.#configPath === undefined) {
        throw new Error("Runtime server was not started from a config file.");
      }
      if (this.#stopPromise !== undefined) {
        throw new Error("Runtime server is shutting down and cannot reload its configuration.");
      }

      const nextConfig = await loadConfigFile(this.#configPath, this.#loadConfigOptions);
      validateAdminSecurity(nextConfig.admin);
      validateReloadConfig(this.#config, nextConfig);
      await this.#replaceRuntimeConfig(nextConfig);
      this.#logger.info("Admin reloaded runtime config.", {
        configPath: this.#configPath,
        enabledChannels: Object.entries(nextConfig.channels)
          .filter(([, channel]) => channel.enabled)
          .map(([channelId, channel]) => ({ channelId, adapter: channel.adapter }))
      });
    });
  }

  async #replaceRuntimeConfig(nextConfig: RuntimeConfig): Promise<void> {
    this.#webhookRegistry.pause();
    this.#webhookRegistry.clear();
    const runtimeShutdown = this.#assembly.quiesce();
    await this.#webhookRegistry.drain();
    await runtimeShutdown;
    await this.#channelManager.disconnectAll();
    await this.#assembly.dispose();
    this.#config = nextConfig;
    try {
      this.#assembly = createRuntimeAssembly({
        config: nextConfig,
        channels: this.#channels,
        logger: this.#logger,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
      });
      await this.#assembly.taskRunner.recover();
      this.#channelManager.attachEnabledChannels(this.#config);
      await this.#channelManager.connectAll();
      this.#webhookRegistry.resume();
    } catch (error) {
      await this.#cleanupStep("drain failed replacement runtime", () => this.#assembly.quiesce());
      await this.#cleanupStep("disconnect failed replacement channels", () => this.#channelManager.disconnectAll());
      await this.#cleanupStep("dispose failed replacement assembly", () => this.#assembly.dispose());
      throw error;
    }
  }

  async #cleanupStep(label: string, operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.#logger.error(`Runtime cleanup failed to ${label}.`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    const result = (async () => {
      await previous;
      return operation();
    })();
    this.#lifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export { startRuntimeServerFromConfigFile } from "./runtime-server-from-config.js";
