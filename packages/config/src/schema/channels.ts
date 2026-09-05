import { z } from "zod";
import { OptionalSecretSchema } from "./shared.js";
import { RiskLevelSchema } from "./permissions.js";

/** OneBot 11 渠道配置模式 */
export const OneBot11ChannelConfigSchema = z
  .object({
    adapter: z.literal("onebot11"),
    provider: z.string().min(1).default("napcat"),
    transport: z.literal("websocket").default("websocket"),
    endpoint: z.string().min(1),
    accessToken: OptionalSecretSchema,
    enabled: z.boolean().default(true),
    riskLevel: RiskLevelSchema.default("high")
  })
  .passthrough();

/** QQ 官方渠道配置模式 */
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

/** 渠道配置模式 */
export const ChannelConfigSchema = z.discriminatedUnion("adapter", [
  OneBot11ChannelConfigSchema,
  QqOfficialChannelConfigSchema
]);

/** 渠道本地标识模式 */
export const ChannelIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message: "Channel id must start with a letter or number and contain only letters, numbers, _ or -."
  });

/** OneBot 11 渠道配置 */
export type OneBot11ChannelConfig = z.infer<typeof OneBot11ChannelConfigSchema>;

/** QQ 官方渠道配置 */
export type QqOfficialChannelConfig = z.infer<typeof QqOfficialChannelConfigSchema>;

/** 渠道配置 */
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
