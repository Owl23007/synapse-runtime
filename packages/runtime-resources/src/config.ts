import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod-config";

/** 提示词注册表开关与外部目录配置模式 */
export const PromptBundleSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    catalogPath: z.string().min(1).optional(),
    defaultPurpose: z.string().min(1).optional()
  })
  .passthrough()
  .superRefine((prompts, ctx) => {
    if ("defaultPromptId" in prompts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultPromptId"],
        message: "prompts.defaultPromptId has been removed; configure prompts.defaultPurpose."
      });
    }
    if (!prompts.enabled) {
      return;
    }

    if (prompts.catalogPath === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalogPath"],
        message: "Prompt Registry requires prompts.catalogPath when enabled."
      });
    }
    if (prompts.defaultPurpose === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultPurpose"],
        message: "Prompt Registry requires prompts.defaultPurpose when enabled."
      });
    }
  });

/** 最终回复表达模式的校验规则 */
export const PresentationModeSchema = z.enum(["deterministic", "model"]);

/** 独立于推理的最终回复表达配置模式 */
export const PresentationSettingsSchema = z
  .object({
    mode: PresentationModeSchema.default("deterministic"),
    profilePath: z.string().min(1).optional(),
    defaultProfileId: z.string().min(1).optional()
  })
  .passthrough()
  .superRefine((presentation, ctx) => {
    if (presentation.mode === "model") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Model presentation is not implemented; use deterministic mode."
      });
    }
    if ((presentation.profilePath === undefined) !== (presentation.defaultProfileId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [presentation.profilePath === undefined ? "profilePath" : "defaultProfileId"],
        message: "presentation.profilePath and presentation.defaultProfileId must be configured together."
      });
    }
  });

/** 提示词注册表开关与外部目录配置 */
export type PromptBundleSettings = z.infer<typeof PromptBundleSettingsSchema>;

/** 最终回复表达模式 */
export type PresentationMode = z.infer<typeof PresentationModeSchema>;

/** 独立于推理的最终回复表达配置 */
export type PresentationSettings = z.infer<typeof PresentationSettingsSchema>;

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const promptsConfig = defineConfig({
  id: "prompts",
  defaults: PromptBundleSettingsSchema.parse({}),
  parse: (value: unknown) => PromptBundleSettingsSchema.parse(value)
});

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const presentationConfig = defineConfig({
  id: "presentation",
  defaults: PresentationSettingsSchema.parse({}),
  parse: (value: unknown) => PresentationSettingsSchema.parse(value)
});
