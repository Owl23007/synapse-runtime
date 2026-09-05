import { z } from "zod";

/** 会话触发模式的校验规则 */
export const TriggerModeSchema = z.enum(["always", "mention", "keyword", "mention_or_keyword", "never"]);

/** 会话触发策略模式 */
export const ConversationTriggerPolicySchema = z
  .object({
    mode: TriggerModeSchema.default("always"),
    keywords: z.array(z.string().min(1)).default([]),
    botUserIds: z.array(z.string().min(1)).default([]),
    commandPrefixes: z.array(z.string().min(1)).default([]),
    allowCommandWithoutMention: z.boolean().default(true)
  })
  .passthrough();

/** 会话历史选取策略模式 */
export const ContextPolicySchema = z
  .object({
    includeHistory: z.boolean().default(true),
    maxMessages: z.number().int().positive().default(20)
  })
  .passthrough();

/** 运行时上下文存储与合成配置模式 */
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
    channelMaxMessages: z.number().int().positive().default(8),
    strategy: z.string().min(1).default("default"),
    cache: z
      .object({
        enabled: z.boolean().default(true)
      })
      .prefault({})
  })
  .passthrough();

/** 持久记忆配置模式 */
export const MemorySettingsSchema = z
  .object({
    enableDurableMemory: z.boolean().default(false)
  })
  .passthrough();

/** 会话路由配置模式 */
export const ConversationSettingsSchema = z
  .object({
    privateTrigger: ConversationTriggerPolicySchema.prefault({ mode: "always" }),
    groupTrigger: ConversationTriggerPolicySchema.prefault({ mode: "mention" }),
    contextPolicy: ContextPolicySchema.prefault({})
  })
  .passthrough();

/** 会话触发模式 */
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

/** 会话触发策略 */
export type ConversationTriggerPolicy = z.infer<typeof ConversationTriggerPolicySchema>;

/** 会话历史选取策略 */
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

/** 运行时上下文存储与合成配置 */
export type RuntimeContextSettings = z.infer<typeof RuntimeContextSettingsSchema>;

/** 持久记忆配置 */
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

/** 会话路由配置 */
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
