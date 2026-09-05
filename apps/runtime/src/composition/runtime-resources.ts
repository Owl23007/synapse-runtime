import { loadLocaleCatalogFileSync } from "@synapse/runtime-i18n/node";
import { applicationLocales, loadApplicationCatalog } from "./locales.js";
import { LocaleResolver } from "@synapse/runtime-i18n";
import type { RuntimeConfig } from "../config/index.js";
import {
  loadPresentationProfileCatalogFileSync,
  resolvePresentationProfile,
  type PresentationProfile
} from "@synapse/runtime-resources";
import type { RuntimeServerLogger } from "../types.js";

/** 加载并组合内置与用户提供的本地化资源 */
export function createLocaleResolverFromConfig(config: RuntimeConfig, logger: RuntimeServerLogger): LocaleResolver {
  const resolver = new LocaleResolver(
    [...new Set([config.locale.default, config.locale.default.split("-")[0]!, "en"])].map(loadApplicationCatalog),
    config.locale.default,
    (event) => {
      logger.warn("Locale key is missing.", event);
    },
    "en"
  );
  for (const definition of applicationLocales) resolver.i18n.register(definition);
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
