import { z } from "zod";
import { RiskLevelSchema } from "@synapse/runtime-permission/config";
/** 渠道实例的配置校验规则 */
export const OneBot11ChannelConfigSchema = z
  .object({
    adapter: z.literal("onebot11"),
    provider: z.string().min(1).default("napcat"),
    transport: z.literal("websocket").default("websocket"),
    endpoint: z.string().min(1),
    accessToken: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    enabled: z.boolean().default(true),
    riskLevel: RiskLevelSchema.default("high")
  })
  .passthrough();

/** 渠道实例的已解析配置 */
export type OneBot11ChannelConfig = z.infer<typeof OneBot11ChannelConfigSchema>;
