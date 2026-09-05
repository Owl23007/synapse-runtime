import { z } from "zod";
import { AgentSettingsSchema } from "./schema/agent.js";
import { ChannelConfigSchema, ChannelIdSchema } from "./schema/channels.js";
import {
  ConversationSettingsSchema,
  MemorySettingsSchema,
  RuntimeContextSettingsSchema
} from "./schema/conversation.js";
import { DEFAULT_PERMISSIONS, PermissionPolicySchema } from "./schema/permissions.js";
import { LocaleSettingsSchema, PresentationSettingsSchema, PromptBundleSettingsSchema } from "./schema/resources.js";
import { AdminSettingsSchema, RuntimeSettingsSchema, ServerSettingsSchema } from "./schema/runtime.js";
import { ToolSettingsSchema } from "./schema/tools.js";

// 保留原有 Schema 导入入口，领域模块仅依赖自身及共享定义，避免循环依赖
export {
  PermissionPolicySchema,
  RiskLevelSchema,
  DEFAULT_PERMISSIONS,
  type PermissionPolicy,
  type RiskLevel
} from "./schema/permissions.js";
export {
  DEFAULT_RUNTIME_DATA_DIR,
  RuntimeModeSchema,
  LogLevelSchema,
  RuntimeSettingsSchema,
  ServerSettingsSchema,
  AdminSettingsSchema,
  type RuntimeMode,
  type LogLevel,
  type RuntimeSettings,
  type ServerSettings,
  type AdminSettings
} from "./schema/runtime.js";
export {
  TriggerModeSchema,
  ConversationTriggerPolicySchema,
  ContextPolicySchema,
  RuntimeContextSettingsSchema,
  MemorySettingsSchema,
  ConversationSettingsSchema,
  type TriggerMode,
  type ConversationTriggerPolicy,
  type ContextPolicy,
  type RuntimeContextSettings,
  type MemorySettings,
  type ConversationSettings
} from "./schema/conversation.js";
export {
  LocaleSettingsSchema,
  PromptBundleSettingsSchema,
  PresentationModeSchema,
  PresentationSettingsSchema,
  type LocaleSettings,
  type PromptBundleSettings,
  type PresentationMode,
  type PresentationSettings
} from "./schema/resources.js";
export {
  BraveWebSearchSettingsSchema,
  SearxngWebSearchSettingsSchema,
  WebSearchSettingsSchema,
  WebToolSettingsSchema,
  ToolSettingsSchema,
  type BraveWebSearchSettings,
  type SearxngWebSearchSettings,
  type WebSearchSettings,
  type WebToolSettings,
  type ToolSettings
} from "./schema/tools.js";
export {
  AgentProviderIdSchema,
  OpenAiCompatibleAgentProviderConfigSchema,
  EchoAgentProviderConfigSchema,
  AgentProviderConfigSchema,
  AgentSettingsSchema,
  type AgentProviderId,
  type OpenAiCompatibleAgentProviderConfig,
  type EchoAgentProviderConfig,
  type AgentProviderConfig,
  type AgentSettings
} from "./schema/agent.js";
export {
  OneBot11ChannelConfigSchema,
  QqOfficialChannelConfigSchema,
  ChannelConfigSchema,
  ChannelIdSchema,
  type OneBot11ChannelConfig,
  type QqOfficialChannelConfig,
  type ChannelConfig
} from "./schema/channels.js";

/**
 * 组合各领域配置并校验跨领域约束
 *
 * 为保持现有配置兼容性，各配置段继续保留未知字段，默认值及校验规则由领域模块维护
 */
export const RuntimeConfigSchema = z
  .object({
    runtime: RuntimeSettingsSchema.default({}),
    server: ServerSettingsSchema.default({}),
    admin: AdminSettingsSchema.default({}),
    context: RuntimeContextSettingsSchema.default({}),
    locale: LocaleSettingsSchema.default({}),
    prompts: PromptBundleSettingsSchema.default({}),
    presentation: PresentationSettingsSchema.default({}),
    memory: MemorySettingsSchema.default({}),
    tools: ToolSettingsSchema.default({}),
    agent: AgentSettingsSchema.default({}),
    conversation: ConversationSettingsSchema.default({}),
    channels: z.record(ChannelIdSchema, ChannelConfigSchema).default({}),
    permissions: z.record(z.string().min(1), PermissionPolicySchema).default(DEFAULT_PERMISSIONS)
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

/** 运行时完整配置 */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
