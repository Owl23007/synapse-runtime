import { z } from "zod";

/** Skill 激活条件，只允许匹配可信场景维度 */
export const SkillActivationSchema = z
  .object({
    mode: z.enum(["explicit", "scene", "explicit_or_scene"]).default("explicit"),
    dimensions: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({})
  })
  .superRefine((activation, context) => {
    if (activation.mode !== "explicit" && Object.keys(activation.dimensions).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: "Scene-activated skills require at least one activation dimension."
      });
    }
  });

/** 可由资源文件声明的 Skill Manifest */
export const SkillManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  version: z.string().min(1).default("1"),
  description: z.string().min(1),
  purposes: z.array(z.string().min(1)).min(1),
  activation: SkillActivationSchema.default({}),
  promptIds: z.array(z.string().min(1)).default([]),
  requiredTools: z.array(z.string().min(1)).default([]),
  optionalTools: z.array(z.string().min(1)).default([]),
  allowedTools: z.array(z.string().min(1)).optional(),
  conflictsWith: z.array(z.string().min(1)).default([]),
  exclusiveGroup: z.string().min(1).optional(),
  priority: z.number().int().default(0),
  trust: z.enum(["runtime", "workspace", "user", "remote"]).default("runtime"),
  cacheScope: z.enum(["global", "workspace", "session", "none"]).default("none")
});

/** 配置作者输入的 Skill Manifest */
export type SkillManifest = z.input<typeof SkillManifestSchema>;

/** 完成默认值填充后的 Skill Manifest */
export type ResolvedSkillManifest = z.output<typeof SkillManifestSchema>;
