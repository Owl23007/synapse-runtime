import { z } from "zod";
import { RiskLevelSchema } from "@synapse/runtime-permission/config";
/** 渠道实例的配置校验规则 */
export const QqOfficialChannelConfigSchema = z
  .object({
    adapter: z.literal("qq-official"),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    mode: z.literal("webhook").default("webhook"),
    apiBaseUrl: z.string().url().optional(),
    tokenEndpoint: z.string().url().optional(),
    webhookPath: z.string().min(1).optional(),
    enabled: z.boolean().default(false),
    riskLevel: RiskLevelSchema.default("low")
  })
  .passthrough();

/** 渠道实例的已解析配置 */
export type QqOfficialChannelConfig = z.infer<typeof QqOfficialChannelConfigSchema>;
