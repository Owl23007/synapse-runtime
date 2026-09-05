import { defineI18n } from "@synapse/runtime-i18n";

/** runtime 模块拥有的语言资源，宿主决定何时加载 */
export const runtimeI18n = defineI18n({
  namespace: "runtime",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/runtime/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/runtime/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/runtime/en.json", import.meta.url),
    "zh-CN": new URL("./locales/runtime/zh-CN.json", import.meta.url)
  }
});

/** context 模块拥有的语言资源，宿主决定何时加载 */
export const contextI18n = defineI18n({
  namespace: "context",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/context/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/context/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/context/en.json", import.meta.url),
    "zh-CN": new URL("./locales/context/zh-CN.json", import.meta.url)
  }
});
