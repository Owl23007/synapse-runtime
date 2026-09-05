import { z } from "zod";

/** 模型提供商本地标识模式 */
export const AgentProviderIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message: "Agent provider id must start with a letter or number and contain only letters, numbers, _ or -."
  });

/** 聊天模型请求调节参数模式 */
const ChatProviderTuningSchema = {
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  extraBody: z.record(z.string().min(1), z.unknown()).default({})
} as const;

/** OpenAI 兼容模型提供商配置模式 */
export const OpenAiCompatibleAgentProviderConfigSchema = z
  .object({
    type: z.literal("openai-compatible"),
    apiKey: z.string().min(1),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    ...ChatProviderTuningSchema
  })
  .passthrough();

/** 回显提供商配置模式 */
export const EchoAgentProviderConfigSchema = z
  .object({
    type: z.literal("echo"),
    prefix: z.string().default("")
  })
  .passthrough();

/** 模型提供商配置模式 */
export const AgentProviderConfigSchema = z.discriminatedUnion("type", [
  OpenAiCompatibleAgentProviderConfigSchema,
  EchoAgentProviderConfigSchema
]);

/** 默认模型与提供商集合配置模式 */
export const AgentSettingsSchema = z
  .object({
    default: AgentProviderIdSchema.optional(),
    providers: z.record(AgentProviderIdSchema, AgentProviderConfigSchema).default({})
  })
  .passthrough()
  .superRefine((agent, ctx) => {
    if ("systemPrompt" in agent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["systemPrompt"],
        message: "agent.systemPrompt has been removed; configure a Prompt Bundle."
      });
    }
    if (agent.default === undefined) {
      return;
    }

    if (agent.providers[agent.default] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `Default agent provider "${agent.default}" is not defined in agent.providers.`
      });
    }
  });

/** 模型提供商本地标识 */
export type AgentProviderId = z.infer<typeof AgentProviderIdSchema>;

/** OpenAI 兼容模型提供商配置 */
export type OpenAiCompatibleAgentProviderConfig = z.infer<typeof OpenAiCompatibleAgentProviderConfigSchema>;

/** 回显提供商配置 */
export type EchoAgentProviderConfig = z.infer<typeof EchoAgentProviderConfigSchema>;

/** 模型提供商配置 */
export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;

/** 默认模型与提供商集合配置 */
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
