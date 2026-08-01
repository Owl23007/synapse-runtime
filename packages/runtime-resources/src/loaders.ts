import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { LocaleCatalogSchema, type LocaleCatalog } from "./locale.js";
import { PromptDefinitionSchema, PromptRegistry, type PromptDefinition } from "./prompt.js";
import { PresentationProfileCatalogSchema, type PresentationProfileCatalog } from "./presentation.js";

const PromptCatalogSchema = z.object({ prompts: z.array(PromptDefinitionSchema) });

/** 资源扩展名只决定解析器，资源结构仍由对应 Schema 统一校验 */
function parseResource(content: string, filePath: string): unknown {
  return extname(filePath).toLowerCase() === ".json" ? JSON.parse(content) : parseYaml(content);
}

/** 同步加载并校验 Locale Catalog */
export function loadLocaleCatalogFileSync(filePath: string): LocaleCatalog {
  return LocaleCatalogSchema.parse(parseResource(readFileSync(filePath, "utf8"), filePath));
}

/** 同步加载并构建 Prompt Registry */
export function loadPromptCatalogFileSync(filePath: string): PromptRegistry {
  return new PromptRegistry(PromptCatalogSchema.parse(parseResource(readFileSync(filePath, "utf8"), filePath)).prompts);
}

/** 异步接口加载并校验 Locale Catalog */
export async function loadLocaleCatalogFile(filePath: string): Promise<LocaleCatalog> {
  return loadLocaleCatalogFileSync(filePath);
}

/** 异步接口加载并构建 Prompt Registry */
export async function loadPromptCatalogFile(filePath: string): Promise<PromptRegistry> {
  return loadPromptCatalogFileSync(filePath);
}

/** 同步加载并校验 Presentation Profile Catalog */
export function loadPresentationProfileCatalogFileSync(filePath: string): PresentationProfileCatalog {
  return PresentationProfileCatalogSchema.parse(parseResource(readFileSync(filePath, "utf8"), filePath));
}

/** 异步接口加载并校验 Presentation Profile Catalog */
export async function loadPresentationProfileCatalogFile(filePath: string): Promise<PresentationProfileCatalog> {
  return loadPresentationProfileCatalogFileSync(filePath);
}

/** 校验内存中的 Prompt Catalog 并返回 Prompt 定义 */
export function parsePromptCatalog(value: unknown): readonly PromptDefinition[] {
  return PromptCatalogSchema.parse(value).prompts;
}
