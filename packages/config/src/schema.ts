import { z } from "zod";
import * as schemas from "./schema/index.js";

// 保留原有 Schema 导入入口
export * from "./schema/index.js";

/**
 * 组合各领域配置并校验跨领域约束
 *
 * 为保持现有配置兼容性，各配置段继续保留未知字段，默认值及校验规则由领域模块维护
 */
export const RuntimeConfigSchema = z
  .object({
    runtime: schemas.RuntimeSettingsSchema.default({}),
    server: schemas.ServerSettingsSchema.default({}),
    admin: schemas.AdminSettingsSchema.default({}),
    context: schemas.RuntimeContextSettingsSchema.default({}),
    locale: schemas.LocaleSettingsSchema.default({}),
    prompts: schemas.PromptBundleSettingsSchema.default({}),
    presentation: schemas.PresentationSettingsSchema.default({}),
    memory: schemas.MemorySettingsSchema.default({}),
    tools: schemas.ToolSettingsSchema.default({}),
    agent: schemas.AgentSettingsSchema.default({}),
    conversation: schemas.ConversationSettingsSchema.default({}),
    channels: z.record(schemas.ChannelIdSchema, schemas.ChannelConfigSchema).default({}),
    permissions: z.record(z.string().min(1), schemas.PermissionPolicySchema).default(schemas.DEFAULT_PERMISSIONS)
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
