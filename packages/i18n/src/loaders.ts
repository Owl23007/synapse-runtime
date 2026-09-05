import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { LocaleCatalogSchema, type LocaleCatalog } from "./locale.js";
/** 资源扩展名只决定解析器，资源结构仍由对应 Schema 统一校验 */
function parseResource(content: string, filePath: string): unknown {
  return extname(filePath).toLowerCase() === ".json" ? JSON.parse(content) : parseYaml(content);
}

/** 同步加载并校验 Locale Catalog */
export function loadLocaleCatalogFileSync(filePath: string): LocaleCatalog {
  return LocaleCatalogSchema.parse(parseResource(readFileSync(filePath, "utf8"), filePath));
}

/** 异步接口加载并校验 Locale Catalog */
export async function loadLocaleCatalogFile(filePath: string): Promise<LocaleCatalog> {
  return loadLocaleCatalogFileSync(filePath);
}
