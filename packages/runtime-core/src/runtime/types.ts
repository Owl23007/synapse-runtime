import type { Agent } from "@synapse/runtime-agent-core";
import type { ChannelRegistry } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import type { ToolRuntime } from "@synapse/runtime-tool-runtime";
import type {
  ContextAttributor,
  ConversationStore,
  EventProcessStore,
  IdentityResolver,
  TranscriptStore,
  WorkspaceResolver,
  WorkspaceStore
} from "../context.js";
import type { PresentationProfile } from "../output/index.js";

/**
 * RuntimeCore 日志记录接口
 */
export interface RuntimeCoreLogger {
  /**
   * 记录普通运行信息
   */
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;

  /**
   * 记录可恢复异常
   */
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;

  /**
   * 记录运行失败
   */
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

/**
 * RuntimeCore 构造参数
 */
export interface RuntimeCoreOptions {
  readonly channels: ChannelRegistry;
  readonly conversation: ConversationRouter;
  readonly agent: Agent;
  readonly tools: ToolRuntime;
  readonly logger?: RuntimeCoreLogger;
  readonly localize?: (key: string, params?: Readonly<Record<string, string>>) => string;
  readonly compileInvocation?: (request: AgentRequest) => ModelInvocationEnvelope | Promise<ModelInvocationEnvelope>;
  readonly memory?: {
    readonly enableDurableMemory?: boolean;
  };
  readonly presentation?: {
    readonly profile?: PresentationProfile;
  };
  readonly context?: {
    readonly enabled?: boolean;
    readonly providerByChannelId?: Readonly<Record<string, string>>;
    readonly conversationStore?: ConversationStore;
    readonly attributor?: ContextAttributor;
    readonly transcriptStore?: TranscriptStore;
    readonly eventProcessStore?: EventProcessStore;
    readonly identityResolver?: IdentityResolver;
    readonly workspaceResolver?: WorkspaceResolver;
    readonly workspaceStore?: WorkspaceStore;
    readonly maxHistoryChars?: number;
    readonly timezone?: string;
    readonly strategy?: string;
    readonly cacheEnabled?: boolean;
    readonly privateHistoryTtlMinutes?: number;
    readonly groupHistoryTtlMinutes?: number;
    readonly channelHistoryTtlMinutes?: number;
    readonly privateMaxMessages?: number;
    readonly groupMaxMessages?: number;
    readonly channelMaxMessages?: number;
  };
}

/**
 * 单次频道事件的运行结果摘要
 */
export interface RuntimeTrace {
  readonly eventId: string;
  readonly status: "ignored" | "succeeded" | "failed" | "blocked";
  readonly reason?: string;
  readonly runId?: string;
}
