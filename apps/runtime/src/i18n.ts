import { defineI18n } from "@synapse/runtime-i18n";

/** admin 模块拥有的语言资源，宿主决定何时加载 */
export const adminI18n = defineI18n({
  namespace: "admin",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/admin/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/admin/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/admin/en.json", import.meta.url),
    "zh-CN": new URL("./locales/admin/zh-CN.json", import.meta.url)
  }
});

/** config 模块拥有的语言资源，宿主决定何时加载 */
export const configI18n = defineI18n({
  namespace: "config",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/config/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/config/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/config/en.json", import.meta.url),
    "zh-CN": new URL("./locales/config/zh-CN.json", import.meta.url)
  }
});

/** locale 模块拥有的语言资源，宿主决定何时加载 */
export const localeI18n = defineI18n({
  namespace: "locale",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/locale/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/locale/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/locale/en.json", import.meta.url),
    "zh-CN": new URL("./locales/locale/zh-CN.json", import.meta.url)
  }
});
