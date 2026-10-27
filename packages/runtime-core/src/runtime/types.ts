import type { Agent } from "@synapse/runtime-agent-core";
import type { ChannelRegistry } from "@synapse/runtime-channel";
import type { AgentRequest, ConversationRouter, ModelInvocationEnvelope } from "@synapse/runtime-conversation";
import type { ToolRuntime } from "@synapse/runtime-tool-runtime";
import type {
  AcceptedNormalizedEvent,
  ContextAttributor,
  ConversationStore,
  EventProcessStore,
  IdentityResolver,
  IdentityStore,
  TranscriptStore,
  WorkspaceResolver,
  WorkspaceStore
} from "../context.js";
import type { PresentationProfile } from "../output/index.js";
import type { MemoryStore } from "../memory/index.js";
import type { ContextGraph } from "../context-graph/index.js";
import type { RunTraceStore } from "../trace/types.js";
import type { SynapseMessage } from "@synapse/runtime-protocol";

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
  /** 仅在发送边界读取工件内容，持久事件与模型输出继续使用引用 */
  readonly materializeMessage?: (sessionId: string, message: SynapseMessage) => SynapseMessage;
  /** 持久化最终回复前移除未选中与重复工件，发送权限仍按最终内容检查 */
  readonly selectMessage?: (sessionId: string, message: SynapseMessage) => SynapseMessage;
  /** 在消息发送前逐项交付工件并落盘回执，避免部分成功被总回复失败掩盖 */
  readonly prepareDelivery?: (input: {
    readonly sessionId: string;
    readonly channelId: string;
    readonly conversationId: string;
    readonly conversationKind: string;
    readonly message: SynapseMessage;
    readonly signal?: AbortSignal;
    readonly observe: (
      type:
        | "artifact_upload_started"
        | "artifact_upload_succeeded"
        | "artifact_upload_failed"
        | "artifact_upload_uncertain",
      data: unknown
    ) => void;
  }) => Promise<
    | { readonly status: "ready"; readonly message: SynapseMessage }
    | { readonly status: "failed" | "uncertain"; readonly error: string }
  >;
  /** 实例运行预算，排队请求不占用执行名额 */
  readonly limits?: {
    readonly maxConcurrent?: number;
    readonly maxQueued?: number;
    readonly runTimeoutMs?: number;
    readonly toolTimeoutMs?: number;
    readonly shutdownGraceMs?: number;
  };
  /** 持久运行追踪，嵌入式宿主可选择自己的存储实现 */
  readonly runs?: RunTraceStore;
  readonly channels: ChannelRegistry;
  readonly conversation: ConversationRouter;
  readonly agent: Agent;
  readonly tools: ToolRuntime;
  readonly logger?: RuntimeCoreLogger;
  readonly localize?: (key: string, params?: Readonly<Record<string, string>>) => string;
  readonly compileInvocation?: (request: AgentRequest) => ModelInvocationEnvelope | Promise<ModelInvocationEnvelope>;
  readonly memory?: {
    readonly enableDurableMemory?: boolean;
    readonly store?: MemoryStore;
  };
  readonly presentation?: {
    readonly profile?: PresentationProfile;
  };
  readonly context?: {
    /** 持久化运行结果图，未注入时保留嵌入式运行的原有行为 */
    readonly graph?: ContextGraph;
    readonly enabled?: boolean;
    readonly providerByChannelId?: Readonly<Record<string, string>>;
    readonly conversationStore?: ConversationStore;
    readonly attributor?: ContextAttributor;
    readonly transcriptStore?: TranscriptStore;
    readonly eventProcessStore?: EventProcessStore;
    readonly identityResolver?: IdentityResolver;
    readonly identityStore?: IdentityStore;
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
    readonly memoryStore?: MemoryStore;
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

/** 频道接收后固定的业务作用域，恢复与调度共用同一持久身份 */
export interface RuntimeEventScope {
  readonly provider: string;
  readonly accepted: AcceptedNormalizedEvent;
  readonly runId?: string;
}
