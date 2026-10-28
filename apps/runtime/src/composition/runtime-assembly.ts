import { recoverArtifactToolOutput } from "@synapse/runtime-core/artifacts";
import { RuntimeInspection } from "@synapse/runtime-core/inspection";
import { type LocaleResolver } from "@synapse/runtime-i18n";
import { join } from "node:path";
import type { ChannelRegistry } from "@synapse/runtime-channel";
import type { ChannelConfig, RuntimeConfig } from "../config/index.js";
import { ConversationRouter, type AgentRequest, type ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import { RuntimeCore, SqliteRuntimeContextStore, TaskRunner } from "@synapse/runtime-core";
import { RuntimeWorkspace } from "@synapse/runtime-core/workspace";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { createWebTools, InMemoryWebCache } from "@synapse/runtime-tool-web";
import { createDockerTool } from "@synapse/runtime-tool-execution";
import { describeToolSet, ToolRuntime } from "@synapse/runtime-tool-runtime";
import { createAgentFromConfig } from "./agent-factory.js";
import { createLocaleResolverFromConfig, createPresentationProfileFromConfig } from "./runtime-resources.js";
import type { RuntimeFetch, RuntimeServerLogger } from "../types.js";
import { compilePromptBundleFileSync, type PromptBundleCompiler } from "@synapse/runtime-resources";
import { ArtifactStore, type DockerCommandRunner } from "@synapse/runtime-tool-container";
import { registerContainerTools } from "./container-tools.js";
import { canUploadGroupFile } from "./channel-delivery.js";
import { collectTraceSecrets } from "../secrets.js";
import { ArtifactDeliveryStore } from "../infrastructure/artifact-delivery.js";
import {
  persistDockerArtifacts,
  materializeArtifactMessage,
  selectArtifactMessage,
  createArtifactDelivery
} from "./docker-artifacts.js";

/** 运行时装配输入，外部执行边界可由宿主注入用于验证 */
export interface RuntimeFactoryOptions {
  readonly config: RuntimeConfig;
  readonly channels: ChannelRegistry;
  readonly logger: RuntimeServerLogger;
  readonly fetch?: RuntimeFetch;
  /** 默认使用真实 Docker CLI，测试可注入受控进程边界 */
  readonly containerRunner?: DockerCommandRunner;
}

/** 完整运行组合的资源所有者，先排空运行和任务，再释放底层存储 */
export class RuntimeAssembly {
  #quiescePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #closed = false;
  /** 与当前组合绑定的查询门面，热重载后由宿主整体替换 */
  readonly inspection: RuntimeInspection;
  /** 与当前执行链路共享会话、分支及上下文图的第一方操作门面 */
  readonly workspace: RuntimeWorkspace;

  /** 接收已经完成装配的资源，构造阶段不启动后台任务 */
  constructor(
    readonly runtime: RuntimeCore,
    readonly contextStore: SqliteRuntimeContextStore,
    readonly tools: ToolRuntime,
    readonly localeResolver: LocaleResolver,
    readonly artifacts: ArtifactStore,
    readonly taskRunner: TaskRunner
  ) {
    this.inspection = new RuntimeInspection(contextStore, artifacts);
    this.workspace = new RuntimeWorkspace(runtime, contextStore);
  }

  /** 供宿主判断查询资源是否仍然可用 */
  get closed(): boolean {
    return this.#closed;
  }

  /** 阻止新运行并等待现有操作结束，保留数据库供宿主排空入口 */
  quiesce(): Promise<void> {
    this.#quiescePromise ??= (async () => {
      await this.runtime.dispose();
      await this.taskRunner.dispose();
    })();
    return this.#quiescePromise;
  }

  /** 幂等释放组合，排空失败时不提前关闭仍可能被使用的数据库 */
  dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      await this.quiesce();
      this.contextStore.close();
      this.#closed = true;
    })();
    return this.#disposePromise;
  }
}

/** 根据配置创建生产运行时，装配失败时关闭已经打开的数据库 */
export function createRuntimeAssembly(options: RuntimeFactoryOptions): RuntimeAssembly {
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
    databasePath: join(options.config.runtime.dataDir, "runtime-context.sqlite"),
    exclusiveOwner: true,
    traceSecrets: collectTraceSecrets(options.config)
  });

  try {
    const artifacts = new ArtifactStore(join(options.config.runtime.dataDir, "artifacts"), options.config.container);
    const deliveries = new ArtifactDeliveryStore(join(options.config.runtime.dataDir, "artifact-deliveries"));
    if (options.config.tools.docker.enabled)
      tools.register(persistDockerArtifacts(createDockerTool(options.config.tools.docker), artifacts));
    contextStore.recoverRuns((request) => recoverArtifactToolOutput(deliveries, request));
    registerContainerTools({
      tools,
      artifacts,
      deliveries,
      settings: options.config.container,
      dataDir: options.config.runtime.dataDir,
      channels: options.channels,
      ...(options.containerRunner === undefined ? {} : { runner: options.containerRunner })
    });
    const taskRunner = new TaskRunner({ store: contextStore, executors: {} });
    const runtime = new RuntimeCore({
      materializeMessage: (sessionId, message) => materializeArtifactMessage(artifacts, sessionId, message),
      selectMessage: (sessionId, message) => selectArtifactMessage(artifacts, sessionId, message),
      prepareDelivery: createArtifactDelivery(artifacts, deliveries, options.channels),
      ...(options.config.runtime.limits === undefined ? {} : { limits: options.config.runtime.limits }),
      runs: contextStore.runs,
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
    return new RuntimeAssembly(runtime, contextStore, tools, localeResolver, artifacts, taskRunner);
  } catch (error) {
    contextStore.close();
    throw error;
  }
}

function createInvocationCompiler(
  config: RuntimeConfig,
  tools: ToolRuntime,
  channels: ChannelRegistry
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
          // 原生会话直接下载本地工件，外部频道仍需具备真实的群文件交付能力
          if (
            ((tool.name === "container.run" && request.source.platform !== "native") ||
              tool.name === "artifact.upload") &&
            (request.source.conversationKind !== "group" || !canUploadGroupFile(channels.get(request.source.channelId)))
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
