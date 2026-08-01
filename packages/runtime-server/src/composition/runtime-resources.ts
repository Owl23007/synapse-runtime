import type { RuntimeConfig } from "@synapse/runtime-config";
import {
  loadLocaleCatalogFileSync,
  loadPresentationProfileCatalogFileSync,
  LocaleResolver,
  resolvePresentationProfile,
  zhCNCoreErrorCatalog,
  type PresentationProfile
} from "@synapse/runtime-resources";
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

/** 加载运行时启用的确定性表达配置 */
export function createPresentationProfileFromConfig(config: RuntimeConfig): PresentationProfile | undefined {
  const { profilePath, defaultProfileId } = config.presentation;
  if (profilePath === undefined || defaultProfileId === undefined) {
    return undefined;
  }
  return resolvePresentationProfile(loadPresentationProfileCatalogFileSync(profilePath), defaultProfileId);
}
