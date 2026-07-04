import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_RUNTIME_DATA_DIR = join(homedir(), ".synapse", "runtime");

export const PermissionPolicySchema = z.enum([
  "allow",
  "confirm",
  "deny",
  "sandbox",
  "rate_limit"
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);

export const RuntimeModeSchema = z.enum(["local", "attached", "hosted"]);

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

const OptionalSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

export const DEFAULT_PERMISSIONS = {
  "channel.qq.send_group_message": "allow",
  "channel.qq.send_channel_message": "allow",
  "channel.qq.send_private_message": "confirm",
  "channel.qq.manage_group": "deny",
  "channel.qq.send_media": "confirm"
} as const;

export const RuntimeSettingsSchema = z
  .object({
    mode: RuntimeModeSchema.default("local"),
    dataDir: z.string().min(1).default(DEFAULT_RUNTIME_DATA_DIR),
    logLevel: LogLevelSchema.default("info")
  })
  .passthrough();

export const ServerSettingsSchema = z
  .object({
    host: z.string().min(1).default("0.0.0.0"),
    port: z.number().int().min(0).max(65535).default(3000),
    publicBaseUrl: z.string().url().optional()
  })
  .passthrough();

export const AdminSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(3766),
    token: OptionalSecretSchema,
    allowedOrigins: z
      .array(z.string().min(1))
      .default(["http://127.0.0.1:3766", "http://localhost:3766"]),
    allowedRemoteAddresses: z
      .array(z.string().min(1))
      .default(["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
    logBufferSize: z.number().int().min(100).max(10_000).default(300)
  })
  .passthrough();

export const TriggerModeSchema = z.enum(["always", "mention", "keyword", "mention_or_keyword", "never"]);

export const ConversationTriggerPolicySchema = z
  .object({
    mode: TriggerModeSchema.default("always"),
    keywords: z.array(z.string().min(1)).default([]),
    botUserIds: z.array(z.string().min(1)).default([]),
    commandPrefixes: z.array(z.string().min(1)).default([]),
    allowCommandWithoutMention: z.boolean().default(true)
  })
  .passthrough();

export const ContextPolicySchema = z
  .object({
    includeHistory: z.boolean().default(true),
    maxMessages: z.number().int().positive().default(20)
  })
  .passthrough();

export const RuntimeContextSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxHistoryChars: z.number().int().positive().default(6000),
    timezone: z.string().min(1).default("UTC"),
    privateHistoryTtlMinutes: z.number().int().positive().default(720),
    groupHistoryTtlMinutes: z.number().int().positive().default(30),
    channelHistoryTtlMinutes: z.number().int().positive().default(30),
    privateMaxMessages: z.number().int().positive().default(20),
    groupMaxMessages: z.number().int().positive().default(6),
    channelMaxMessages: z.number().int().positive().default(8)
  })
  .passthrough();

export const MemorySettingsSchema = z
  .object({
    enableDurableMemory: z.boolean().default(false)
  })
  .passthrough();

export const ConversationSettingsSchema = z
  .object({
    privateTrigger: ConversationTriggerPolicySchema.default({ mode: "always" }),
    groupTrigger: ConversationTriggerPolicySchema.default({ mode: "mention" }),
    contextPolicy: ContextPolicySchema.default({})
  })
  .passthrough();

export const AgentProviderIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message: "Agent provider id must start with a letter or number and contain only letters, numbers, _ or -."
  });

export const AgentProviderBaseSchema = z.string().min(1);

const ChatProviderTuningSchema = {
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  extraBody: z.record(z.string().min(1), z.unknown()).default({})
} as const;

export const QwenAgentProviderConfigSchema = z
  .object({
    type: z.literal("qwen"),
    base: z.literal("qwen").default("qwen"),
    apiKey: z.string().min(1),
    model: z.string().min(1).default("qwen-plus"),
    baseUrl: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ...ChatProviderTuningSchema
  })
  .passthrough();

export const OpenAiCompatibleAgentProviderConfigSchema = z
  .object({
    type: z.literal("openai-compatible"),
    base: AgentProviderBaseSchema.optional(),
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    ...ChatProviderTuningSchema
  })
  .passthrough();

export const EchoAgentProviderConfigSchema = z
  .object({
    type: z.literal("echo"),
    prefix: z.string().default("")
  })
  .passthrough();

export const AgentProviderConfigSchema = z.discriminatedUnion("type", [
  QwenAgentProviderConfigSchema,
  OpenAiCompatibleAgentProviderConfigSchema,
  EchoAgentProviderConfigSchema
]).superRefine((provider, ctx) => {
  if (provider.type !== "openai-compatible" || provider.base !== undefined) {
    return;
  }

  // 未选择内置预设时，必须显式声明调用地址和模型，避免新增厂商时修改代码表。
  if (provider.baseUrl === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "baseUrl is required when openai-compatible provider base is not set."
    });
  }

  if (provider.model === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model"],
      message: "model is required when openai-compatible provider base is not set."
    });
  }
});

export const AgentSettingsSchema = z
  .object({
    default: AgentProviderIdSchema.optional(),
    systemPrompt: z.string().min(1).optional(),
    providers: z.record(AgentProviderIdSchema, AgentProviderConfigSchema).default({})
  })
  .passthrough()
  .superRefine((agent, ctx) => {
    if (agent.default === undefined) {
      return;
    }

    if (agent.providers[agent.default] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `Default agent provider "${agent.default}" is not defined in agent.providers.`
      });
    }
  });

export const OneBot11ChannelConfigSchema = z
  .object({
    adapter: z.literal("onebot11"),
    provider: z.string().min(1).default("napcat"),
    transport: z.enum(["websocket", "http", "http-websocket"]).default("websocket"),
    endpoint: z.string().min(1),
    accessToken: OptionalSecretSchema,
    enabled: z.boolean().default(true),
    riskLevel: RiskLevelSchema.default("high")
  })
  .passthrough();

export const QqOfficialChannelConfigSchema = z
  .object({
    adapter: z.literal("qq-official"),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    mode: z.enum(["webhook", "websocket"]).default("webhook"),
    apiBaseUrl: z.string().url().optional(),
    tokenEndpoint: z.string().url().optional(),
    webhookPath: z.string().min(1).optional(),
    enabled: z.boolean().default(false),
    riskLevel: RiskLevelSchema.default("low")
  })
  .passthrough();

export const ChannelConfigSchema = z.discriminatedUnion("adapter", [
  OneBot11ChannelConfigSchema,
  QqOfficialChannelConfigSchema
]);

export const ChannelIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message: "Channel id must start with a letter or number and contain only letters, numbers, _ or -."
  });

export const RuntimeConfigSchema = z
  .object({
    runtime: RuntimeSettingsSchema.default({}),
    server: ServerSettingsSchema.default({}),
    admin: AdminSettingsSchema.default({}),
    context: RuntimeContextSettingsSchema.default({}),
    memory: MemorySettingsSchema.default({}),
    agent: AgentSettingsSchema.default({}),
    conversation: ConversationSettingsSchema.default({}),
    channels: z.record(ChannelIdSchema, ChannelConfigSchema).default({}),
    permissions: z
      .record(z.string().min(1), PermissionPolicySchema)
      .default(DEFAULT_PERMISSIONS)
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (config.runtime.mode !== "hosted") {
      return;
    }

    for (const [channelId, channel] of Object.entries(config.channels)) {
      if (channel.adapter === "onebot11" && channel.enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["channels", channelId],
          message: "Hosted mode cannot enable onebot11 channels."
        });
      }
    }
  });

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export type TriggerMode = z.infer<typeof TriggerModeSchema>;
export type ConversationTriggerPolicy = z.infer<typeof ConversationTriggerPolicySchema>;
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
export type RuntimeContextSettings = z.infer<typeof RuntimeContextSettingsSchema>;
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
export type AgentProviderId = z.infer<typeof AgentProviderIdSchema>;
export type AgentProviderBase = z.infer<typeof AgentProviderBaseSchema>;
export type QwenAgentProviderConfig = z.infer<typeof QwenAgentProviderConfigSchema>;
export type OpenAiCompatibleAgentProviderConfig = z.infer<typeof OpenAiCompatibleAgentProviderConfigSchema>;
export type EchoAgentProviderConfig = z.infer<typeof EchoAgentProviderConfigSchema>;
export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type OneBot11ChannelConfig = z.infer<typeof OneBot11ChannelConfigSchema>;
export type QqOfficialChannelConfig = z.infer<typeof QqOfficialChannelConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
