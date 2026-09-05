import { defineI18n } from "@synapse/runtime-i18n";

/** tool 模块拥有的语言资源，宿主决定何时加载 */
export const toolI18n = defineI18n({
  namespace: "tool",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/tool/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/tool/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/tool/en.json", import.meta.url),
    "zh-CN": new URL("./locales/tool/zh-CN.json", import.meta.url)
  }
});
