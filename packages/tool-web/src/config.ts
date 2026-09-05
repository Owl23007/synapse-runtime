import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod";

/** Brave 网络搜索配置模式 */
export const BraveWebSearchSettingsSchema = z
  .object({
    provider: z.literal("brave"),
    apiKey: z.string().min(1),
    baseUrl: z.string().url().default("https://api.search.brave.com/res/v1/web/search")
  })
  .passthrough();

/** SearXNG 网络搜索配置模式 */
export const SearxngWebSearchSettingsSchema = z
  .object({
    provider: z.literal("searxng"),
    baseUrl: z.string().url()
  })
  .passthrough();

/** 网络搜索提供商配置模式 */
export const WebSearchSettingsSchema = z.discriminatedUnion("provider", [
  BraveWebSearchSettingsSchema,
  SearxngWebSearchSettingsSchema
]);

/** 内置网络工具配置模式 */
export const WebToolSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedDomains: z.array(z.string().min(1)).default([]),
    deniedDomains: z.array(z.string().min(1)).default([]),
    allowPrivateNetwork: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxResponseBytes: z.number().int().min(1024).max(10_000_000).default(2_000_000),
    maxContentChars: z.number().int().min(1000).max(200_000).default(24_000),
    maxRedirects: z.number().int().min(0).max(10).default(5),
    cacheTtlMs: z.number().int().positive().max(86_400_000).default(300_000),
    userAgent: z.string().min(1).default("SynapseRuntime/0.1"),
    search: WebSearchSettingsSchema.optional()
  })
  .passthrough();

/** 内置工具集合配置模式 */
export const ToolSettingsSchema = z
  .object({
    web: WebToolSettingsSchema.prefault({})
  })
  .passthrough();

/** Brave 网络搜索配置 */
export type BraveWebSearchSettings = z.infer<typeof BraveWebSearchSettingsSchema>;

/** SearXNG 网络搜索配置 */
export type SearxngWebSearchSettings = z.infer<typeof SearxngWebSearchSettingsSchema>;

/** 网络搜索提供商配置 */
export type WebSearchSettings = z.infer<typeof WebSearchSettingsSchema>;

/** 内置网络工具配置 */
export type WebToolSettings = z.infer<typeof WebToolSettingsSchema>;

/** 内置工具集合配置 */
export type ToolSettings = z.infer<typeof ToolSettingsSchema>;

/** 模块配置令牌，默认值与校验由所属模块维护 */
export const toolsConfig = defineConfig({
  id: "tools",
  defaults: ToolSettingsSchema.parse({}),
  parse: (value: unknown) => ToolSettingsSchema.parse(value)
});
