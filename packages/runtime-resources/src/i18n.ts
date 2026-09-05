import { defineI18n } from "@synapse/runtime-i18n";

/** presentation 模块拥有的语言资源，宿主决定何时加载 */
export const presentationI18n = defineI18n({
  namespace: "presentation",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/presentation/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/presentation/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/presentation/en.json", import.meta.url),
    "zh-CN": new URL("./locales/presentation/zh-CN.json", import.meta.url)
  }
});

/** prompt 模块拥有的语言资源，宿主决定何时加载 */
export const promptI18n = defineI18n({
  namespace: "prompt",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/prompt/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/prompt/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/prompt/en.json", import.meta.url),
    "zh-CN": new URL("./locales/prompt/zh-CN.json", import.meta.url)
  }
});

/** resource 模块拥有的语言资源，宿主决定何时加载 */
export const resourceI18n = defineI18n({
  namespace: "resource",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/resource/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/resource/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/resource/en.json", import.meta.url),
    "zh-CN": new URL("./locales/resource/zh-CN.json", import.meta.url)
  }
});

/** skill 模块拥有的语言资源，宿主决定何时加载 */
export const skillI18n = defineI18n({
  namespace: "skill",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/skill/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/skill/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/skill/en.json", import.meta.url),
    "zh-CN": new URL("./locales/skill/zh-CN.json", import.meta.url)
  }
});
