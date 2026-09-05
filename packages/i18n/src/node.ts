import { readFileSync } from "node:fs";
import type { I18nDefinition, Messages } from "./manager.js";
import { flatten } from "./manager.js";
import type { LocaleCatalog } from "./locale.js";

export * from "./loaders.js";

/** 为同步 CLI 宿主读取指定语言，资源路径由模块声明，缓存由国际化实例维护 */
export function loadDefinitionCatalogSync(definition: I18nDefinition, locale: string): LocaleCatalog {
  const path = definition.resourcePaths?.[locale];
  if (path === undefined) return { locale, messages: {} };
  const messages = flatten(JSON.parse(readFileSync(path, "utf8")) as Messages);
  return {
    locale,
    messages: Object.fromEntries(
      Object.entries(messages).map(([key, value]) => [`${definition.namespace}.${key}`, value])
    )
  };
}
