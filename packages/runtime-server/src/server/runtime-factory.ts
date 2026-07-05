import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import type { ChannelConfig, RuntimeConfig } from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { RuntimeCore, SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import type { RuntimeFetch, RuntimeServerLogger } from "../types.js";

export interface RuntimeFactoryOptions {
  readonly config: RuntimeConfig;
  readonly channels: InMemoryChannelRegistry;
  readonly logger: RuntimeServerLogger;
  readonly fetch?: RuntimeFetch;
}

export interface RuntimeFactoryResult {
  readonly runtime: RuntimeCore;
  readonly contextStore?: SqliteRuntimeContextStore;
}

export function createRuntimeFromConfig(options: RuntimeFactoryOptions): RuntimeFactoryResult {
  const agent = createAgentFromConfig(options.config, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const conversation = new ConversationRouter(options.config.conversation);
  const tools = new ToolRuntime(new StaticPermissionEngine(options.config.permissions));
  const contextStore = options.config.context.enabled
    ? new SqliteRuntimeContextStore({
        databasePath: join(options.config.runtime.dataDir, "runtime-context.sqlite")
      })
    : undefined;

  return {
    runtime: new RuntimeCore({
      channels: options.channels,
      conversation,
      agent,
      tools,
      logger: options.logger,
      memory: {
        enableDurableMemory: durableMemoryEnabled(options.config)
      },
      context: {
        enabled: options.config.context.enabled,
        maxHistoryChars: options.config.context.maxHistoryChars,
        timezone: options.config.context.timezone,
        privateHistoryTtlMinutes: options.config.context.privateHistoryTtlMinutes,
        groupHistoryTtlMinutes: options.config.context.groupHistoryTtlMinutes,
        channelHistoryTtlMinutes: options.config.context.channelHistoryTtlMinutes,
        privateMaxMessages: options.config.context.privateMaxMessages,
        groupMaxMessages: options.config.context.groupMaxMessages,
        channelMaxMessages: options.config.context.channelMaxMessages,
        providerByChannelId: providerByChannelId(options.config.channels),
        ...(contextStore === undefined
          ? {}
          : {
              transcriptStore: contextStore,
              eventProcessStore: contextStore
            })
      }
    }),
    ...(contextStore === undefined ? {} : { contextStore })
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
