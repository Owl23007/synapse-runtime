import { z } from "zod";
import * as schemas from "./definitions.js";

export * from "./definitions.js";

/**
 * 组合各领域配置并校验跨领域约束
 *
 * 配置段使用 prefault 补充解析前输入，使缺省配置仍经过内部字段的默认值与校验流程
 */
export const RuntimeConfigSchema = z
  .object({
    runtime: schemas.RuntimeSettingsSchema.prefault({}),
    server: schemas.ServerSettingsSchema.prefault({}),
    admin: schemas.AdminSettingsSchema.prefault({}),
    context: schemas.RuntimeContextSettingsSchema.prefault({}),
    locale: schemas.LocaleSettingsSchema.prefault({}),
    prompts: schemas.PromptBundleSettingsSchema.prefault({}),
    presentation: schemas.PresentationSettingsSchema.prefault({}),
    memory: schemas.MemorySettingsSchema.prefault({}),
    tools: schemas.ToolSettingsSchema.prefault({}),
    agent: schemas.AgentSettingsSchema.prefault({}),
    conversation: schemas.ConversationSettingsSchema.prefault({}),
    channels: z.record(schemas.ChannelIdSchema, schemas.ChannelConfigSchema).default({}),
    permissions: z.record(z.string().min(1), schemas.PermissionPolicySchema).default(schemas.DEFAULT_PERMISSIONS)
  })
  .passthrough()
  .superRefine((config, ctx) => {
    // 代理模式下，禁止启用 onebot11 适配器的频道
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
