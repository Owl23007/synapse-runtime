import { z } from "zod";
import { ResourceError } from "./errors.js";

/** 确定性表达配置，只允许影响最终文本形态的字段 */
export const PresentationProfileSchema = z
  .object({
    id: z.string().min(1),
    locale: z.string().min(1).default("zh-CN"),
    enabled: z.boolean().default(true),
    maxChars: z.number().int().positive().optional(),
    maxParagraphs: z.number().int().positive().optional(),
    allowMarkdown: z.boolean().optional(),
    allowCodeBlock: z.boolean().optional()
  })
  .strict();

/** 表达配置资源文件校验规则 */
export const PresentationProfileCatalogSchema = z
  .object({ profiles: z.array(PresentationProfileSchema) })
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    for (const [index, profile] of catalog.profiles.entries()) {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "id"],
          message: `Duplicate presentation profile id "${profile.id}".`
        });
      }
      ids.add(profile.id);
    }
  });

/** 确定性表达配置 */
export type PresentationProfile = z.infer<typeof PresentationProfileSchema>;

/** 表达配置资源文件 */
export type PresentationProfileCatalog = z.infer<typeof PresentationProfileCatalogSchema>;

/** 从 Catalog 中选择已启用的表达配置 */
export function resolvePresentationProfile(
  catalog: PresentationProfileCatalog,
  profileId: string
): PresentationProfile {
  const profile = catalog.profiles.find((candidate) => candidate.id === profileId && candidate.enabled);
  if (profile === undefined) {
    throw new ResourceError({
      code: "PRESENTATION_PROFILE_NOT_FOUND",
      key: "presentation.profile_not_found",
      params: { profileId },
      severity: "fatal",
      expose: false
    });
  }
  return profile;
}
