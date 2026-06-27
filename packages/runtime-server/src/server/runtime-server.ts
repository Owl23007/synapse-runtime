import { InMemoryChannelRegistry, type ChannelAdapter } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "@synapse/runtime-channel-qq-official";
import { loadConfigFile, redactConfig, type ChannelConfig } from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { RuntimeCore } from "@synapse/runtime-core";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { bodyParser, createApp, type Nova, type NovaRequest, type NovaResponse } from "nova-http";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import { createChannelAdapter } from "../composition/channel-factory.js";
import { DEFAULT_LOGGER, createLevelLogger } from "../logging.js";
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

export async function startRuntimeServerFromConfigFile(
  configPath: string,
  options: Omit<RuntimeServerOptions, "config"> = {}
): Promise<RuntimeServer> {
  const config = await loadConfigFile(configPath);
  const server = new RuntimeServer({ ...options, config });
  await server.start();
  return server;
}
