import { defineConfig } from "@synapse/runtime-config";
import { z } from "zod";

/** 默认循环的资源预算，由循环实现独立维护 */
export const AgentLoopSettingsSchema = z.object({
  maxSteps: z.number().int().positive().default(8),
  maxToolCalls: z.number().int().positive().default(16)
});

/** 默认循环已解析的配置类型 */
export type AgentLoopSettings = z.infer<typeof AgentLoopSettingsSchema>;

/** 默认循环的配置令牌，与模型服务连接参数独立 */
export const agentLoopConfig = defineConfig({
  id: "agentLoop",
  defaults: AgentLoopSettingsSchema.parse({}),
  parse: (value: unknown) => AgentLoopSettingsSchema.parse(value)
});
