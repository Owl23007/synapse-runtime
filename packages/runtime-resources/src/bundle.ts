import { createHash } from "node:crypto";
import type { ModelInvocationEnvelope, PromptEnvelopeBlock, PromptScene } from "@synapse/runtime-conversation";
import { z } from "zod";
import { ResourceError } from "./errors.js";
import { PromptDefinitionSchema, PromptRegistry, type PromptDefinition, renderPrompt } from "./prompt.js";
import { SkillManifestSchema, type ResolvedSkillManifest, type SkillManifest } from "./skill.js";

/** Prompt Recipe 的结构校验规则 */
export const PromptRecipeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  version: z.string().min(1).default("1"),
  purpose: z.string().min(1),
  basePromptIds: z.array(z.string().min(1)).min(1),
  dimensions: z.record(z.string().min(1), z.record(z.string().min(1), z.array(z.string().min(1)))).default({})
});

/** Prompt、Recipe 与 Skill 的原子资源包 */
export const PromptBundleSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  prompts: z.array(PromptDefinitionSchema),
  recipes: z.array(PromptRecipeSchema).default([]),
  skills: z.array(SkillManifestSchema).default([])
});

/** 配置作者输入的 Prompt Recipe */
export type PromptRecipe = z.input<typeof PromptRecipeSchema>;

/** 完成默认值填充后的 Prompt Recipe */
export type ResolvedPromptRecipe = z.output<typeof PromptRecipeSchema>;

/** 配置作者输入的完整 Prompt Bundle */
export interface PromptBundle {
  readonly schemaVersion?: 1;
  readonly prompts: readonly PromptDefinition[];
  readonly recipes?: readonly PromptRecipe[];
  readonly skills?: readonly SkillManifest[];
}

/** 一次模型调用编译所需的结构化输入 */
export interface InvocationCompileInput {
  readonly purpose: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly toolIds: readonly string[];
  readonly toolSetDigest: string;
  readonly requestedSkillIds?: readonly string[];
}

const SLOT_ORDER = ["runtime", "behavior", "capability", "scene", "skill", "workspace", "output"] as const;
const MAX_COMPOSITION_CACHE_ENTRIES = 256;

/** 启动时完成资源引用校验并在请求阶段合成 Invocation Envelope */
export class PromptBundleCompiler {
  readonly #registry: PromptRegistry;
  readonly #recipes = new Map<string, ResolvedPromptRecipe>();
  readonly #skills = new Map<string, ResolvedSkillManifest>();
  readonly #values: Readonly<Record<string, string>>;
  readonly #rendered = new Map<string, PromptEnvelopeBlock>();
  readonly #cache = new Map<string, ModelInvocationEnvelope>();

  /** 使用资源包和稳定编译变量创建编译器 */
  constructor(bundle: PromptBundle, values: Readonly<Record<string, string>>) {
    const parsed = PromptBundleSchema.parse(bundle);
    this.#registry = new PromptRegistry(parsed.prompts);
    this.#values = values;
    const recipeIds = new Set<string>();
    for (const recipe of parsed.recipes) {
      if (recipeIds.has(recipe.id)) this.#duplicate("recipe", recipe.id);
      if (this.#recipes.has(recipe.purpose)) this.#duplicate("recipe purpose", recipe.purpose);
      recipeIds.add(recipe.id);
      this.#recipes.set(recipe.purpose, recipe);
    }
    for (const skill of parsed.skills) {
      if (this.#skills.has(skill.id)) this.#duplicate("skill", skill.id);
      this.#skills.set(skill.id, skill);
    }
    this.#validateReferences();
    // 所有启用模板都在启动阶段完成变量校验和稳定渲染
    for (const prompt of this.#registry.list()) if (prompt.enabled) this.#compilePrompt(prompt.id);
  }

  /** 判断资源包是否声明指定模型调用用途 */
  hasPurpose(purpose: string): boolean {
    return this.#recipes.has(purpose);
  }

  /** 为结构化场景、Tools 和显式 Skill 请求生成不可变 Invocation Envelope */
  compile(input: InvocationCompileInput): ModelInvocationEnvelope {
    const recipe = this.#recipes.get(input.purpose);
    if (recipe === undefined) {
      throw new ResourceError({
        code: "PROMPT_RECIPE_NOT_FOUND",
        key: "prompt.recipe_not_found",
        params: { purpose: input.purpose }
      });
    }
    const requestedSkillIds = deduplicate(input.requestedSkillIds ?? []).toSorted();
    const cacheKey = stableDigest({
      recipe: `${recipe.id}@${recipe.version}`,
      dimensions: input.dimensions,
      tools: input.toolSetDigest,
      requestedSkillIds
    });
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const activeSkills = this.#activateSkills(input, requestedSkillIds);
    this.#validateSkillConflicts(activeSkills);
    const effectiveToolIds = this.#resolveTools(input.toolIds, activeSkills);
    const promptIds = deduplicate([
      ...recipe.basePromptIds,
      ...Object.entries(recipe.dimensions).flatMap(([dimension, variants]) => {
        const value = input.dimensions[dimension] ?? "default";
        const selected = variants[value] ?? variants.default;
        if (selected === undefined) {
          throw new ResourceError({
            code: "PROMPT_DIMENSION_VARIANT_NOT_FOUND",
            key: "prompt.dimension_variant_not_found",
            params: { recipe: recipe.id, dimension, value }
          });
        }
        return selected;
      }),
      ...activeSkills.flatMap((skill) => skill.promptIds)
    ]);
    const blocks = promptIds
      .map((id) => this.#compilePrompt(id))
      .toSorted(
        (left, right) =>
          SLOT_ORDER.indexOf(left.slot as (typeof SLOT_ORDER)[number]) -
          SLOT_ORDER.indexOf(right.slot as (typeof SLOT_ORDER)[number])
      );
    const scene: PromptScene = { purpose: input.purpose, dimensions: input.dimensions };
    const skillRefs = activeSkills.map((skill) => ({
      id: skill.id,
      version: skill.version,
      reason: skill.activation.mode
    }));
    const result: ModelInvocationEnvelope = {
      prompt: {
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        scene,
        blocks,
        digest: stableDigest(blocks.map(({ promptId, version, content }) => ({ promptId, version, content })))
      },
      capabilities: {
        toolIds: effectiveToolIds,
        toolSetDigest: stableDigest({ source: input.toolSetDigest, effectiveToolIds }),
        activeSkills: skillRefs,
        skillSetDigest: stableDigest(skillRefs)
      }
    };
    if (this.#cache.size >= MAX_COMPOSITION_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(cacheKey, result);
    return result;
  }

  #compilePrompt(id: string): PromptEnvelopeBlock {
    const cached = this.#rendered.get(id);
    if (cached !== undefined) return cached;
    const prompt = this.#registry.get(id)!;
    const block: PromptEnvelopeBlock = {
      promptId: prompt.id,
      version: prompt.version,
      stage: prompt.stage,
      slot: prompt.slot,
      content: renderPrompt(prompt, { ...this.#values }),
      stable: prompt.stablePrefix,
      cacheScope: prompt.cacheScope
    };
    this.#rendered.set(id, block);
    return block;
  }

  #activateSkills(input: InvocationCompileInput, requested: readonly string[]): readonly ResolvedSkillManifest[] {
    const requestedSet = new Set(requested);
    for (const id of requestedSet) if (!this.#skills.has(id)) this.#missing("skill", id);
    for (const id of requestedSet) {
      const skill = this.#skills.get(id)!;
      if (!skill.purposes.includes(input.purpose)) {
        throw new ResourceError({
          code: "SKILL_PURPOSE_MISMATCH",
          key: "skill.purpose_mismatch",
          params: { skill: id, purpose: input.purpose }
        });
      }
      if (skill.activation.mode === "scene") {
        throw new ResourceError({
          code: "SKILL_ACTIVATION_NOT_ALLOWED",
          key: "skill.activation_not_allowed",
          params: { skill: id }
        });
      }
    }
    return [...this.#skills.values()]
      .filter((skill) => {
        if (!skill.purposes.includes(input.purpose)) return false;
        const explicit = requestedSet.has(skill.id);
        const scene = Object.entries(skill.activation.dimensions).every(([dimension, values]) =>
          values.includes(input.dimensions[dimension] ?? "")
        );
        if (skill.activation.mode === "explicit") return explicit;
        if (skill.activation.mode === "scene") return scene;
        return explicit || scene;
      })
      .toSorted((left, right) => right.priority - left.priority || left.id.localeCompare(right.id, "en"));
  }

  #resolveTools(toolIds: readonly string[], skills: readonly ResolvedSkillManifest[]): readonly string[] {
    const available = new Set(toolIds);
    for (const skill of skills) {
      for (const toolId of skill.requiredTools) {
        if (!available.has(toolId)) {
          throw new ResourceError({
            code: "SKILL_TOOL_REQUIRED",
            key: "skill.tool_required",
            params: { skill: skill.id, tool: toolId }
          });
        }
      }
    }
    let effective = new Set(available);
    for (const skill of skills) {
      if (skill.allowedTools !== undefined) {
        const allowed = new Set(skill.allowedTools);
        effective = new Set([...effective].filter((id) => allowed.has(id)));
      }
    }
    return [...effective].toSorted((left, right) => left.localeCompare(right, "en"));
  }

  #validateReferences(): void {
    for (const recipe of this.#recipes.values()) {
      const stage = stageFromPurpose(recipe.purpose);
      for (const id of [
        ...recipe.basePromptIds,
        ...Object.values(recipe.dimensions).flatMap((variants) => Object.values(variants).flat())
      ]) {
        const prompt = this.#requirePrompt(id);
        if (stage !== undefined && prompt.stage !== stage) {
          throw new ResourceError({
            code: "PROMPT_STAGE_MISMATCH",
            key: "prompt.stage_mismatch",
            params: { id, expected: stage, actual: prompt.stage }
          });
        }
      }
    }
    for (const skill of this.#skills.values()) {
      for (const id of skill.promptIds) {
        const prompt = this.#requirePrompt(id);
        if (skill.trust !== "runtime" && ["runtime", "behavior", "capability", "output"].includes(prompt.slot)) {
          throw new ResourceError({
            code: "SKILL_PROMPT_AUTHORITY_INVALID",
            key: "skill.prompt_authority_invalid",
            params: { skill: skill.id, prompt: id, slot: prompt.slot }
          });
        }
      }
    }
  }

  #validateSkillConflicts(skills: readonly ResolvedSkillManifest[]): void {
    const active = new Set(skills.map((skill) => skill.id));
    const groups = new Set<string>();
    for (const skill of skills) {
      const conflict = skill.conflictsWith.find((id) => active.has(id));
      if (conflict !== undefined) {
        throw new ResourceError({
          code: "SKILL_CONFLICT",
          key: "skill.conflict",
          params: { left: skill.id, right: conflict }
        });
      }
      if (skill.exclusiveGroup !== undefined) {
        if (groups.has(skill.exclusiveGroup)) {
          throw new ResourceError({
            code: "SKILL_CONFLICT",
            key: "skill.exclusive_group",
            params: { group: skill.exclusiveGroup }
          });
        }
        groups.add(skill.exclusiveGroup);
      }
    }
  }

  #requirePrompt(id: string) {
    const prompt = this.#registry.get(id);
    if (prompt === undefined) this.#missing("prompt", id);
    if (!prompt.enabled) {
      throw new ResourceError({ code: "PROMPT_DISABLED", key: "prompt.disabled", params: { id } });
    }
    return prompt;
  }

  #missing(kind: string, id: string): never {
    throw new ResourceError({
      code: "RESOURCE_REFERENCE_NOT_FOUND",
      key: "resource.reference_not_found",
      params: { kind, id }
    });
  }

  #duplicate(kind: string, id: string): never {
    throw new ResourceError({ code: "RESOURCE_DUPLICATE", key: "resource.duplicate", params: { kind, id } });
  }
}

function stageFromPurpose(purpose: string): "reasoning" | "internal" | "presentation" | undefined {
  const stage = purpose.split(".", 1)[0];
  return stage === "reasoning" || stage === "internal" || stage === "presentation" ? stage : undefined;
}

function deduplicate(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
