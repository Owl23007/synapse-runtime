import { defineConfig } from "@synapse/runtime-config";
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

/** 会话路由配置 */
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const conversationConfig = defineConfig({
  id: "conversation",
  defaults: ConversationSettingsSchema.parse({}),
  parse: (value: unknown) => ConversationSettingsSchema.parse(value)
});
