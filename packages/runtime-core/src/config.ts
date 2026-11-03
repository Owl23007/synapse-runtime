import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod";

/** 自主执行的宿主硬上限，模型只能在这些额度内创建工作 */
export const AutonomySettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1000),
    maxPendingIntents: z.number().int().min(1).max(10_000).default(128),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retryBaseDelayMs: z.number().int().min(100).max(60_000).default(1000),
    maxRetryDelayMs: z.number().int().min(100).max(3_600_000).default(60_000),
    maxRunsPerHour: z.number().int().min(1).max(10_000).default(60),
    maxRunsPerGrant: z.number().int().min(1).max(1000).default(24),
    maxModelCallsPerRun: z.number().int().min(1).max(64).default(8),
    maxToolCallsPerRun: z.number().int().min(1).max(128).default(16),
    maxTasks: z.number().int().min(1).max(1000).default(32),
    maxTaskDepth: z.number().int().min(1).max(8).default(3),
    maxSchedules: z.number().int().min(1).max(1000).default(16),
    maxScheduleOccurrences: z.number().int().min(1).max(1000).default(24),
    maxScheduleLifetimeHours: z.number().int().min(1).max(8760).default(168),
    minScheduleIntervalMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
    maxContextCommits: z.number().int().min(1).max(100_000).default(1000),
    maxRecordChars: z.number().int().min(1024).max(1_000_000).default(32_000),
    retentionHours: z.number().int().min(1).max(8760).default(168),
    observationTtlMinutes: z.number().int().min(1).max(1440).default(30),
    maxObservationsPerSession: z.number().int().min(1).max(1000).default(64),
    maxDatabaseBytes: z
      .number()
      .int()
      .min(16 * 1024 * 1024)
      .max(16 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024)
  })
  .strict()
  .refine(
    (value) => value.maxRetryDelayMs >= value.retryBaseDelayMs,
    "maxRetryDelayMs must not be below retryBaseDelayMs"
  );

/** 已校验的自主执行与数据保留配置 */
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;

/** 自主执行配置令牌，未知配置项直接拒绝 */
export const autonomyConfig = defineConfig({
  id: "autonomy",
  defaults: AutonomySettingsSchema.parse({}),
  parse: (value: unknown) => AutonomySettingsSchema.parse(value)
});

/** 文件限额与只读目录由管理员定义，不接受模型提供宿主路径 */
export const FilesSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxNativeUploadBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  maxRemoteFetchBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024)
    .default(50 * 1024 * 1024),
  maxConcurrentFetches: z.number().int().positive().max(16).default(2),
  cacheMaxBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  remoteAllowedHosts: z.array(z.string().min(1)).default([]),
  mounts: z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9-]*$/),
          root: z.string().min(1),
          urlPrefix: z.string().regex(/^\/files\/[a-z][a-z0-9-]*$/),
          access: z.enum(["private", "authenticated", "public"]).default("authenticated"),
          allowPublic: z.boolean().default(false),
          readOnly: z.literal(true).default(true)
        })
        .refine((value) => value.access !== "public" || value.allowPublic, "Public mounts require allowPublic")
    )
    .default([])
});

/** 文件领域配置令牌 */
export const filesConfig = defineConfig({
  id: "files",
  defaults: FilesSettingsSchema.parse({}),
  parse: (value: unknown) => FilesSettingsSchema.parse(value)
});
/** 运行时上下文存储与合成配置模式 */
export const RuntimeContextSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxHistoryChars: z.number().int().positive().default(6000),
    maxTotalChars: z.number().int().min(1024).max(500_000).default(24_000),
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
