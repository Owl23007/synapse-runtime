import enCoreErrorCatalogConfig from "./locales/en.json" with { type: "json" };
import zhCNCoreErrorCatalogConfig from "./locales/zh-CN.json" with { type: "json" };
import { LocaleCatalogSchema, type LocaleCatalog } from "./locale.js";

/** Runtime 内置中文错误资源，可由外部 Catalog 按 Key 覆盖 */
export const zhCNCoreErrorCatalog: LocaleCatalog = LocaleCatalogSchema.parse(zhCNCoreErrorCatalogConfig);

/** Runtime 内置英文错误资源，可由外部 Catalog 按 Key 覆盖 */
export const enCoreErrorCatalog: LocaleCatalog = LocaleCatalogSchema.parse(enCoreErrorCatalogConfig);
