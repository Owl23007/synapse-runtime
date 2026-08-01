import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import type { ChannelConfig, RuntimeConfig } from "@synapse/runtime-config";
import { ConversationRouter } from "@synapse/runtime-conversation";
import { RuntimeCore, SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { createWebTools } from "@synapse/runtime-tool-web";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import {
  createLocaleResolverFromConfig,
  createPresentationProfileFromConfig
} from "../composition/runtime-resources.js";
import type { RuntimeFetch, RuntimeServerLogger } from "../types.js";
import type { LocaleResolver } from "@synapse/runtime-resources";

export interface RuntimeFactoryOptions {
  readonly config: RuntimeConfig;
  readonly channels: InMemoryChannelRegistry;
  readonly logger: RuntimeServerLogger;
  readonly fetch?: RuntimeFetch;
}

export interface RuntimeFactoryResult {
  readonly runtime: RuntimeCore;
  readonly contextStore: SqliteRuntimeContextStore;
  /** 当前生产运行时实际注册的工具集合 */
  readonly tools: ToolRuntime;
  readonly localeResolver: LocaleResolver;
}

export function createRuntimeFromConfig(options: RuntimeFactoryOptions): RuntimeFactoryResult {
  const localeResolver = createLocaleResolverFromConfig(options.config, options.logger);
  const presentationProfile = createPresentationProfileFromConfig(options.config);
  const agent = createAgentFromConfig(options.config, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const conversation = new ConversationRouter(options.config.conversation);
  const tools = new ToolRuntime(new StaticPermissionEngine(options.config.permissions));
  registerBuiltInTools(tools, options.config);
  const contextStore = new SqliteRuntimeContextStore({
    databasePath: join(options.config.runtime.dataDir, "runtime-context.sqlite")
  });

  try {
    const runtime = new RuntimeCore({
      channels: options.channels,
      conversation,
      agent,
      tools,
      logger: options.logger,
      localize: (key, params) => localeResolver.resolve(key, params, options.config.locale.default),
      memory: {
        enableDurableMemory: durableMemoryEnabled(options.config)
      },
      presentation: {
        ...(presentationProfile === undefined ? {} : { profile: presentationProfile })
      },
      context: {
        enabled: options.config.context.enabled,
        maxHistoryChars: options.config.context.maxHistoryChars,
        timezone: options.config.context.timezone,
        structured: options.config.prompts.enabled,
        strategy: options.config.context.strategy,
        cacheEnabled: options.config.context.cache.enabled,
        privateHistoryTtlMinutes: options.config.context.privateHistoryTtlMinutes,
        groupHistoryTtlMinutes: options.config.context.groupHistoryTtlMinutes,
        channelHistoryTtlMinutes: options.config.context.channelHistoryTtlMinutes,
        privateMaxMessages: options.config.context.privateMaxMessages,
        groupMaxMessages: options.config.context.groupMaxMessages,
        channelMaxMessages: options.config.context.channelMaxMessages,
        providerByChannelId: providerByChannelId(options.config.channels),
        conversationStore: contextStore,
        eventProcessStore: contextStore,
        ...(options.config.context.enabled ? { transcriptStore: contextStore } : {})
      }
    });
    return { runtime, contextStore, tools, localeResolver };
  } catch (error) {
    contextStore.close();
    throw error;
  }
}

function registerBuiltInTools(tools: ToolRuntime, config: RuntimeConfig): void {
  const web = config.tools.web;
  if (!web.enabled) {
    return;
  }
  const builtIns = createWebTools({
    ...(web.search === undefined ? {} : { search: web.search }),
    allowedDomains: web.allowedDomains,
    deniedDomains: web.deniedDomains,
    allowPrivateNetwork: web.allowPrivateNetwork,
    timeoutMs: web.timeoutMs,
    maxResponseBytes: web.maxResponseBytes,
    maxContentChars: web.maxContentChars,
    maxRedirects: web.maxRedirects,
    userAgent: web.userAgent
  });
  for (const tool of builtIns) {
    tools.register(tool);
  }
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
