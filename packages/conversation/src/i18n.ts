import { defineI18n } from "@synapse/runtime-i18n";

/** conversation 模块拥有的语言资源，宿主决定何时加载 */
export const conversationI18n = defineI18n({
  namespace: "conversation",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/conversation/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/conversation/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/conversation/en.json", import.meta.url),
    "zh-CN": new URL("./locales/conversation/zh-CN.json", import.meta.url)
  }
});
