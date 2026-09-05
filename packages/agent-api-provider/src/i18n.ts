import { defineI18n } from "@synapse/runtime-i18n";

/** agent 模块拥有的语言资源，宿主决定何时加载 */
export const agentI18n = defineI18n({
  namespace: "agent",
  canonicalLocale: "en",
  resources: {
    en: () => import("./locales/agent/en.json", { with: { type: "json" } }),
    "zh-CN": () => import("./locales/agent/zh-CN.json", { with: { type: "json" } })
  },
  resourcePaths: {
    en: new URL("./locales/agent/en.json", import.meta.url),
    "zh-CN": new URL("./locales/agent/zh-CN.json", import.meta.url)
  }
});
