import { z } from "zod";
import { ResourceError } from "./errors.js";

/** Prompt 定义及其稳定前缀元数据的校验规则 */
export const PromptDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    version: z.string().min(1).default("1"),
    locale: z.string().min(1).default("zh-CN"),
    stage: z.enum(["reasoning", "internal", "presentation", "system", "tool"]),
    scene: z.string().min(1).optional(),
    slot: z.enum(["runtime", "behavior", "capability", "scene", "skill", "workspace", "output"]).default("scene"),
    template: z.string(),
    variables: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).default([]),
    enabled: z.boolean().default(true),
    cacheGroup: z.string().min(1).optional(),
    stablePrefix: z.boolean().default(false),
    cacheScope: z.enum(["global", "workspace", "session", "none"]).default("none"),
    outputContractVersion: z.string().min(1).optional(),
    description: z.string().optional()
  })
  .superRefine((value, context) => {
    // 模板只能访问显式声明的变量，避免配置内容隐式读取运行时数据
    const used = extractTemplateVariables(value.template);
    const declared = new Set(value.variables);
    for (const name of used) {
      if (!declared.has(name))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Prompt ${value.id} uses undeclared variable: ${name}`
        });
    }
  });

/** 配置作者输入的 Prompt 定义，默认字段由 Schema 补齐 */
export type PromptDefinition = z.input<typeof PromptDefinitionSchema>;

/** 完成校验和默认值填充后的 Prompt 定义 */
export type ResolvedPromptDefinition = z.output<typeof PromptDefinitionSchema>;

/** 统一维护 Prompt 定义并提供稳定错误码和安全渲染 */
export class PromptRegistry {
  private readonly prompts = new Map<string, ResolvedPromptDefinition>();

  /** 使用一组 Prompt 定义创建 Registry */
  constructor(definitions: readonly PromptDefinition[] = []) {
    for (const definition of definitions) this.add(definition);
  }

  /** 注册并校验单个 Prompt 定义 */
  add(definition: PromptDefinition): this {
    const parsed = PromptDefinitionSchema.parse(definition);
    if (this.prompts.has(parsed.id))
      throw new ResourceError({ code: "PROMPT_DUPLICATE", key: "prompt.duplicate", params: { id: parsed.id } });
    this.prompts.set(parsed.id, parsed);
    return this;
  }

  /** 按稳定 ID 查询 Prompt 定义 */
  get(id: string): ResolvedPromptDefinition | undefined {
    return this.prompts.get(id);
  }

  /** 按注册顺序列出全部 Prompt 定义 */
  list(): readonly ResolvedPromptDefinition[] {
    return [...this.prompts.values()];
  }

  /** 按 ID 渲染已启用的 Prompt */
  render(id: string, values: Record<string, string>): string {
    const prompt = this.prompts.get(id);
    if (!prompt) throw new ResourceError({ code: "PROMPT_NOT_FOUND", key: "prompt.not_found", params: { id } });
    if (!prompt.enabled) throw new ResourceError({ code: "PROMPT_DISABLED", key: "prompt.disabled", params: { id } });
    return renderPrompt(prompt, values);
  }
}

/** 提取模板中去重后的变量名 */
export function extractTemplateVariables(template: string): readonly string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!))];
}

/** 校验变量完整性并渲染 Prompt 模板 */
export function renderPrompt(prompt: PromptDefinition, values: Record<string, string>): string {
  const definition = PromptDefinitionSchema.parse(prompt);
  const missing = definition.variables.filter((name) => values[name] === undefined);
  if (missing.length)
    throw new ResourceError({
      code: "PROMPT_VARIABLE_MISSING",
      key: "prompt.variables_missing",
      params: { id: definition.id, variables: missing.join(", ") }
    });
  return definition.template.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
    (_match, name: string) => values[name] ?? ""
  );
}
