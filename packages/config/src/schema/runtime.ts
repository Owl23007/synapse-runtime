import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { OptionalSecretSchema } from "./shared.js";

/** 默认运行时数据目录，位于当前用户主目录下 */
export const DEFAULT_RUNTIME_DATA_DIR = join(homedir(), ".synapse", "runtime");

/** 运行模式的校验规则 */
export const RuntimeModeSchema = z.enum(["local", "attached", "hosted"]);

/** 日志等级模式 */
export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

/** 运行时基础配置模式 */
export const RuntimeSettingsSchema = z
  .object({
    mode: RuntimeModeSchema.default("local"),
    dataDir: z.string().min(1).default(DEFAULT_RUNTIME_DATA_DIR),
    logLevel: LogLevelSchema.default("info")
  })
  .passthrough();

/** 业务服务监听配置模式 */
export const ServerSettingsSchema = z
  .object({
    host: z.string().min(1).default("0.0.0.0"),
    port: z.number().int().min(0).max(65535).default(3000),
    publicBaseUrl: z.string().url().optional()
  })
  .passthrough();

/** 管理服务配置模式 */
export const AdminSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(3766),
    token: OptionalSecretSchema,
    allowedOrigins: z.array(z.string().min(1)).default(["http://127.0.0.1:3766", "http://localhost:3766"]),
    allowedRemoteAddresses: z.array(z.string().min(1)).default(["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
    logBufferSize: z.number().int().min(100).max(10_000).default(300)
  })
  .passthrough();

/** 运行模式 */
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

/** 日志等级 */
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** 运行时基础配置 */
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/** 业务服务监听配置 */
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

/** 管理服务配置 */
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
