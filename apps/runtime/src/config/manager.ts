import { z } from "zod";
import { ConfigManager, defineConfig, type ConfigSource } from "@synapse/runtime-config";
import {
  agentConfig,
  agentLoopConfig,
  conversationConfig,
  contextConfig,
  memoryConfig,
  promptsConfig,
  presentationConfig,
  toolsConfig,
  RuntimeSettingsSchema,
  ServerSettingsSchema,
  AdminSettingsSchema,
  LocaleSettingsSchema,
  ChannelConfigSchema,
  ChannelIdSchema,
  PermissionPolicySchema,
  DEFAULT_PERMISSIONS
} from "./definitions.js";
import { RuntimeConfigSchema, type RuntimeConfig } from "./schema.js";

/** 应用自身的运行与部署配置，业务模块不反向读取此定义 */
export const runtimeConfig = defineConfig({
  id: "runtime",
  defaults: RuntimeSettingsSchema.parse({}),
  parse: (value: unknown) => RuntimeSettingsSchema.parse(value)
});
/** 应用业务监听配置令牌 */
export const serverConfig = defineConfig({
  id: "server",
  defaults: ServerSettingsSchema.parse({}),
  parse: (value: unknown) => ServerSettingsSchema.parse(value)
});
/** 应用管理接口配置令牌 */
export const adminConfig = defineConfig({
  id: "admin",
  defaults: AdminSettingsSchema.parse({}),
  parse: (value: unknown) => AdminSettingsSchema.parse(value)
});
/** 应用全局语言策略令牌 */
export const localeConfig = defineConfig({
  id: "locale",
  defaults: LocaleSettingsSchema.parse({}),
  parse: (value: unknown) => LocaleSettingsSchema.parse(value)
});
/** 应用启用的适配器集合，联合类型仅在组合层存在 */
export const channelsConfig = defineConfig({
  id: "channels",
  defaults: {},
  parse: (value: unknown) => z.record(ChannelIdSchema, ChannelConfigSchema).parse(value)
});
/** 应用权限策略，业务能力名称仅在组合层枚举 */
export const permissionsConfig = defineConfig({
  id: "permissions",
  defaults: DEFAULT_PERMISSIONS as Record<string, "allow" | "deny">,
  merge: (_base, override) => override as Record<string, "allow" | "deny">,
  parse: (value: unknown) => z.record(z.string().min(1), PermissionPolicySchema).parse(value)
});

/** 注册本应用使用的模块，基础设施无需维护业务中央注册表 */
export function createApplicationConfigManager(sources: readonly ConfigSource[]): ConfigManager {
  const manager = new ConfigManager(sources);
  manager.register(runtimeConfig);
  manager.register(serverConfig);
  manager.register(adminConfig);
  manager.register(localeConfig);
  manager.register(channelsConfig);
  manager.register(permissionsConfig);
  manager.register(agentConfig);
  manager.register(conversationConfig);
  manager.register(contextConfig);
  manager.register(memoryConfig);
  manager.register(agentLoopConfig);
  manager.register(promptsConfig);
  manager.register(presentationConfig);
  manager.register(toolsConfig);
  return manager;
}

/** 将已解析模块组合为执行时视图，并验证跨模块约束 */
export function readApplicationConfig(manager: ConfigManager): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    runtime: manager.get(runtimeConfig),
    server: manager.get(serverConfig),
    admin: manager.get(adminConfig),
    locale: manager.get(localeConfig),
    channels: manager.get(channelsConfig),
    permissions: manager.get(permissionsConfig),
    agent: manager.get(agentConfig),
    conversation: manager.get(conversationConfig),
    context: manager.get(contextConfig),
    memory: manager.get(memoryConfig),
    agentLoop: manager.get(agentLoopConfig),
    prompts: manager.get(promptsConfig),
    presentation: manager.get(presentationConfig),
    tools: manager.get(toolsConfig)
  });
}
