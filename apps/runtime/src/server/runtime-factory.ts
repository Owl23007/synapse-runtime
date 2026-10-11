import { type LocaleResolver } from "@synapse/runtime-i18n";
import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import type { ChannelConfig, RuntimeConfig } from "../config/index.js";
import { ConversationRouter, type AgentRequest, type ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import { RuntimeCore, SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { createWebTools, InMemoryWebCache } from "@synapse/runtime-tool-web";
import { createDockerTool } from "@synapse/runtime-tool-execution";
import { describeToolSet, ToolRuntime } from "@synapse/runtime-tool-runtime";
import { createAgentFromConfig } from "../composition/agent-factory.js";
import {
  createLocaleResolverFromConfig,
  createPresentationProfileFromConfig
} from "../composition/runtime-resources.js";
import type { RuntimeFetch, RuntimeServerLogger } from "../types.js";
import { compilePromptBundleFileSync, type PromptBundleCompiler } from "@synapse/runtime-resources";
import type { DockerCommandRunner } from "@synapse/runtime-tool-container";
import { registerContainerTools } from "../composition/container-tools.js";

/** 运行时装配输入，外部执行边界可由宿主注入用于验证 */
export interface RuntimeFactoryOptions {
  readonly config: RuntimeConfig;
  readonly channels: InMemoryChannelRegistry;
  readonly logger: RuntimeServerLogger;
  readonly fetch?: RuntimeFetch;
  /** 默认使用真实 Docker CLI，测试可注入受控进程边界 */
  readonly containerRunner?: DockerCommandRunner;
}

/** 已装配的运行时及其由宿主统一管理的资源 */
export interface RuntimeFactoryResult {
  readonly runtime: RuntimeCore;
  readonly contextStore: SqliteRuntimeContextStore;
  /** 当前生产运行时实际注册的工具集合 */
  readonly tools: ToolRuntime;
  readonly localeResolver: LocaleResolver;
}

/** 根据配置创建生产运行时，装配失败时关闭已经打开的数据库 */
export function createRuntimeFromConfig(options: RuntimeFactoryOptions): RuntimeFactoryResult {
  const localeResolver = createLocaleResolverFromConfig(options.config, options.logger);
  const presentationProfile = createPresentationProfileFromConfig(options.config);
  const agent = createAgentFromConfig(options.config, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const conversation = new ConversationRouter(options.config.conversation);
  const tools = new ToolRuntime(new StaticPermissionEngine(options.config.permissions));
  registerBuiltInTools(tools, options.config);
  const compileInvocation = createInvocationCompiler(options.config, tools, options.channels);
  const contextStore = new SqliteRuntimeContextStore({
    databasePath: join(options.config.runtime.dataDir, "runtime-context.sqlite")
  });

  try {
    registerContainerTools({
      tools,
      settings: options.config.container,
      dataDir: options.config.runtime.dataDir,
      channels: options.channels,
      ...(options.containerRunner === undefined ? {} : { runner: options.containerRunner })
    });
    const runtime = new RuntimeCore({
      channels: options.channels,
      conversation,
      agent,
      tools,
      logger: options.logger,
      localize: (key, params) => localeResolver.resolve(key, params, options.config.locale.default),
      ...(compileInvocation === undefined ? {} : { compileInvocation }),
      memory: {
        enableDurableMemory: durableMemoryEnabled(options.config)
      },
      presentation: {
        ...(presentationProfile === undefined ? {} : { profile: presentationProfile })
      },
      context: {
        graph: contextStore.contextGraph,
        enabled: options.config.context.enabled,
        maxHistoryChars: options.config.context.maxHistoryChars,
        timezone: options.config.context.timezone,
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

function createInvocationCompiler(
  config: RuntimeConfig,
  tools: ToolRuntime,
  channels: InMemoryChannelRegistry
): ((request: AgentRequest) => Promise<ModelInvocationEnvelope>) | undefined {
  if (
    !config.prompts.enabled ||
    config.prompts.defaultPurpose === undefined ||
    config.prompts.catalogPath === undefined
  ) {
    return undefined;
  }
  const compiler = compilePromptBundleFileSync(config.prompts.catalogPath, {
    locale: config.locale.default,
    contextStrategy: config.context.strategy,
    runtimeName: "Synapse Runtime"
  });
  if (!compiler.hasPurpose(config.prompts.defaultPurpose)) {
    throw new Error(`Prompt Bundle does not define the default purpose "${config.prompts.defaultPurpose}".`);
  }
  return async (request) => {
    const visibleTools = (
      await Promise.all(
        tools.list().map(async (tool) => {
          // 群文件工具只向具备实际交付能力的当前群开放，避免模型先生成无法交付的文件
          if (
            (tool.name === "container.run" || tool.name === "artifact.upload") &&
            (request.source.conversationKind !== "group" ||
              !channels.get(request.source.channelId)?.getCapabilities().uploadGroupFile)
          )
            return undefined;
          // 动态权限依赖模型生成的参数，只能在实际调用时最终判断
          if (typeof tool.permission === "function") return tool;
          const decision = await tools.decidePermission({
            action: tool.permission.action,
            resource: tool.permission.resource,
            subject: request.userId
          });
          return decision.decision === "allow" ? tool : undefined;
        })
      )
    ).filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
    const toolSet = describeToolSet(visibleTools);
    const purpose = resolvePurpose(compiler, config.prompts.defaultPurpose!, request);
    return compiler.compile({
      purpose,
      dimensions: {
        conversationKind: normalizeConversationKind(request.source.conversationKind),
        lineKind: request.branchId === undefined ? "mainline" : "branch",
        executionKind: request.taskId === undefined ? "interactive" : "task",
        toolMode: toolSet.toolIds.length === 0 ? "disabled" : "enabled"
      },
      toolIds: toolSet.toolIds,
      toolSetDigest: toolSet.digest,
      ...(request.requestedSkillIds === undefined ? {} : { requestedSkillIds: request.requestedSkillIds })
    });
  };
}

function resolvePurpose(compiler: PromptBundleCompiler, fallback: string, request: AgentRequest): string {
  return request.taskId !== undefined && compiler.hasPurpose("reasoning.task_execute")
    ? "reasoning.task_execute"
    : fallback;
}

function normalizeConversationKind(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized === "direct") return "private";
  if (normalized === "private" || normalized === "group" || normalized === "channel") return normalized;
  return "unknown";
}

function registerBuiltInTools(tools: ToolRuntime, config: RuntimeConfig): void {
  if (config.tools.docker.enabled) {
    tools.register(createDockerTool(config.tools.docker));
  }
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
    userAgent: web.userAgent,
    cache: new InMemoryWebCache(),
    ...(typeof web.cacheTtlMs === "number" ? { cacheTtlMs: web.cacheTtlMs } : {})
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
