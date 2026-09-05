import { z } from "zod";
import { OneBot11ChannelConfigSchema } from "@synapse/runtime-channel-onebot11/config";
export * from "@synapse/runtime-channel-onebot11/config";
import { QqOfficialChannelConfigSchema } from "@synapse/runtime-channel-qq-official/config";
export * from "@synapse/runtime-channel-qq-official/config";
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

/** 应用启用的渠道配置联合类型 */
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
