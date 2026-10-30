import { z } from "zod";
import { defineConfig } from "@synapse/runtime-config";

/** 远程 MCP 连接只接受管理员配置的 HTTP 端点与环境变量引用 */
export const McpServerSettingsSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    transport: z.literal("streamable-http").default("streamable-http"),
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      }, "MCP URL cannot contain credentials or query parameters"),
    enabled: z.boolean().default(true),
    authTokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional()
  })
  .strict();

/** MCP 预算、目标白名单和连接配置 */
export const McpSettingsSchema = z
  .object({
    servers: z.array(McpServerSettingsSchema).default([]),
    allowedHosts: z.array(z.string().min(1)).default([]),
    privateHosts: z.array(z.string().min(1)).default([]),
    timeoutMs: z.number().int().positive().max(120000).default(30000),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .default(2 * 1024 * 1024)
  })
  .superRefine((value, context) => {
    if (new Set(value.servers.map((server) => server.id)).size !== value.servers.length)
      context.addIssue({ code: "custom", message: "MCP server IDs must be unique" });
  });

/** 完成默认值填充的 MCP 连接配置 */
export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;

/** MCP 配置令牌，环境变量凭据由应用装配读取 */
export const mcpConfig = defineConfig({
  id: "mcp",
  defaults: McpSettingsSchema.parse({}),
  parse: (value: unknown) => McpSettingsSchema.parse(value)
});
