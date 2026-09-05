import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod";
/** 运行时上下文存储与合成配置模式 */
export const RuntimeContextSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxHistoryChars: z.number().int().positive().default(6000),
    timezone: z.string().min(1).default("UTC"),
    privateHistoryTtlMinutes: z.number().int().positive().default(720),
    groupHistoryTtlMinutes: z.number().int().positive().default(30),
    channelHistoryTtlMinutes: z.number().int().positive().default(30),
    privateMaxMessages: z.number().int().positive().default(20),
    groupMaxMessages: z.number().int().positive().default(6),
    channelMaxMessages: z.number().int().positive().default(8),
    strategy: z.string().min(1).default("default"),
    cache: z
      .object({
        enabled: z.boolean().default(true)
      })
      .prefault({})
  })
  .passthrough();

/** 持久记忆配置模式 */
export const MemorySettingsSchema = z
  .object({
    enableDurableMemory: z.boolean().default(false)
  })
  .passthrough();

/** 运行时上下文存储与合成配置 */
export type RuntimeContextSettings = z.infer<typeof RuntimeContextSettingsSchema>;

/** 持久记忆配置 */
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const contextConfig = defineConfig({
  id: "context",
  defaults: RuntimeContextSettingsSchema.parse({}),
  parse: (value: unknown) => RuntimeContextSettingsSchema.parse(value)
});

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const memoryConfig = defineConfig({
  id: "memory",
  defaults: MemorySettingsSchema.parse({}),
  parse: (value: unknown) => MemorySettingsSchema.parse(value)
});
