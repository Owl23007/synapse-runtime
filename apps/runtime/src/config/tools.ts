import { defineConfig } from "@synapse/runtime-config";
import { ToolSettingsSchema as WebToolSettingsSchema } from "@synapse/runtime-tool-web/config";
import { DockerToolSettingsSchema } from "@synapse/runtime-tool-execution/config";
import { z } from "zod";

export * from "@synapse/runtime-tool-web/config";

/** 应用组合的工具配置，各能力独立启用 */
export const ToolSettingsSchema = WebToolSettingsSchema.extend({ docker: DockerToolSettingsSchema.prefault({}) });

/** 应用组合的工具配置类型 */
export type ToolSettings = z.infer<typeof ToolSettingsSchema>;

/** 应用工具配置令牌，统一保留来源覆盖与校验 */
export const toolsConfig = defineConfig({
  id: "tools",
  defaults: ToolSettingsSchema.parse({}),
  parse: (value: unknown) => ToolSettingsSchema.parse(value)
});
