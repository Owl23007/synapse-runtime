import { z } from "zod";
/** 用户可见消息的语言资源配置模式 */
export const LocaleSettingsSchema = z
  .object({
    default: z.string().min(1).default("zh-CN"),
    catalogPath: z.string().min(1).optional()
  })
  .passthrough();

/** 用户可见消息的语言资源配置 */
export type LocaleSettings = z.infer<typeof LocaleSettingsSchema>;
