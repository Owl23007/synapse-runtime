import type { LocaleCatalog, I18nDefinition } from "@synapse/runtime-i18n";
import { agentI18n } from "@synapse/runtime-agent-api-provider/i18n";
import { runtimeI18n, contextI18n } from "@synapse/runtime-core/i18n";
import { toolI18n } from "@synapse/runtime-tool-runtime/i18n";
import { permissionI18n } from "@synapse/runtime-permission/i18n";
import { conversationI18n } from "@synapse/runtime-conversation/i18n";
import { adminI18n, configI18n, localeI18n } from "../i18n.js";
import { presentationI18n, promptI18n, resourceI18n, skillI18n } from "@synapse/runtime-resources/i18n";
import { loadDefinitionCatalogSync } from "@synapse/runtime-i18n/node";

/** 本应用启用的命名空间，基础设施不持有此列表 */
export const applicationLocales: readonly I18nDefinition[] = [
  agentI18n,
  runtimeI18n,
  contextI18n,
  toolI18n,
  permissionI18n,
  conversationI18n,
  adminI18n,
  configI18n,
  localeI18n,
  presentationI18n,
  promptI18n,
  resourceI18n,
  skillI18n
];

/** 只读取指定语言的已启用模块资源 */
export function loadApplicationCatalog(locale: string): LocaleCatalog {
  return {
    locale,
    messages: Object.assign(
      {},
      ...applicationLocales.map((definition) => loadDefinitionCatalogSync(definition, locale).messages)
    )
  };
}
