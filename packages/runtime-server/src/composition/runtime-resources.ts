import type { RuntimeConfig } from "@synapse/runtime-config";
import { loadLocaleCatalogFileSync, LocaleResolver, zhCNCoreErrorCatalog } from "@synapse/runtime-resources";
import type { RuntimeServerLogger } from "../types.js";

/** 加载并组合内置与用户提供的本地化资源。 */
export function createLocaleResolverFromConfig(config: RuntimeConfig, logger: RuntimeServerLogger): LocaleResolver {
  const resolver = new LocaleResolver([zhCNCoreErrorCatalog], config.locale.default, (event) => {
    logger.warn("Locale key is missing.", event);
  });
  if (config.locale.catalogPath !== undefined) {
    resolver.add(loadLocaleCatalogFileSync(config.locale.catalogPath));
  }
  return resolver;
}
