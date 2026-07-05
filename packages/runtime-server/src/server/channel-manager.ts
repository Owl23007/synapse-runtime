import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import type { ChannelConfig, RuntimeConfig } from "@synapse/runtime-config";
import { redactConfig } from "@synapse/runtime-config";
import type { RuntimeCore } from "@synapse/runtime-core";
import { createChannelAdapter } from "../composition/channel-factory.js";
import type { RuntimeFetch, RuntimeServerLogger } from "../types.js";
import { summarizeChannelConfig } from "./summaries.js";
import type { ChannelAdminPatch } from "./admin/dto.js";
import { QqOfficialWebhookRegistry } from "./webhook-registry.js";

export interface RuntimeChannelManagerOptions {
  readonly channels: InMemoryChannelRegistry;
  readonly webhookRegistry: QqOfficialWebhookRegistry;
  readonly logger: RuntimeServerLogger;
  readonly fetch?: RuntimeFetch;
  readonly getRuntime: () => RuntimeCore;
  readonly getConfig: () => RuntimeConfig;
  readonly setConfig: (config: RuntimeConfig) => void;
}

export class RuntimeChannelManager {
  readonly #channels: InMemoryChannelRegistry;
  readonly #webhookRegistry: QqOfficialWebhookRegistry;
  readonly #logger: RuntimeServerLogger;
  readonly #fetch: RuntimeFetch | undefined;
  readonly #getRuntime: () => RuntimeCore;
  readonly #getConfig: () => RuntimeConfig;
  readonly #setConfig: (config: RuntimeConfig) => void;

  constructor(options: RuntimeChannelManagerOptions) {
    this.#channels = options.channels;
    this.#webhookRegistry = options.webhookRegistry;
    this.#logger = options.logger;
    this.#fetch = options.fetch;
    this.#getRuntime = options.getRuntime;
    this.#getConfig = options.getConfig;
    this.#setConfig = options.setConfig;
  }

  async connectAll(): Promise<void> {
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
  }

  async disconnectAll(): Promise<void> {
    const channels = this.#channels.list();

    for (const channel of channels) {
      this.#channels.unregister(channel.id);
    }

    await Promise.all(channels.map((channel) => channel.disconnect()));
  }

  attachEnabledChannels(config: RuntimeConfig): void {
    for (const [channelId, channelConfig] of Object.entries(config.channels)) {
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
      this.#getRuntime().attachChannel(channel);
      this.#webhookRegistry.register(channelId, channelConfig, channel);
    }
  }

  async applyChannelPatch(channelId: string, channelConfig: ChannelConfig, patch: ChannelAdminPatch): Promise<void> {
    if (patch.enabled === undefined || patch.enabled === channelConfig.enabled) {
      return;
    }

    if (patch.enabled) {
      await this.#enableChannel(channelId, { ...channelConfig, enabled: true } as ChannelConfig);
      return;
    }

    await this.#disableChannel(channelId, { ...channelConfig, enabled: false } as ChannelConfig);
  }

  async getAdminChannelSummaries(): Promise<unknown[]> {
    return Promise.all(
      Object.entries(this.#getConfig().channels).map(([channelId, channelConfig]) =>
        this.getAdminChannelSummary(channelId, channelConfig)
      )
    );
  }

  async getAdminChannelSummary(channelId: string, channelConfig: ChannelConfig): Promise<unknown> {
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

  async #enableChannel(channelId: string, channelConfig: ChannelConfig): Promise<void> {
    if (this.#channels.get(channelId) !== undefined) {
      this.#setConfig(updateChannelConfig(this.#getConfig(), channelId, channelConfig));
      return;
    }

    const channel = createChannelAdapter(channelId, channelConfig, {
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch })
    });
    this.#getRuntime().attachChannel(channel);
    this.#webhookRegistry.register(channelId, channelConfig, channel);
    await channel.connect();
    this.#setConfig(updateChannelConfig(this.#getConfig(), channelId, channelConfig));
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

    this.#webhookRegistry.remove(channelId, channelConfig);
    this.#setConfig(updateChannelConfig(this.#getConfig(), channelId, channelConfig));
    this.#logger.info("Admin disabled channel.", {
      channelId,
      adapter: channelConfig.adapter
    });
  }
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
