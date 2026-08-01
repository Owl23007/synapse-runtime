export { zhCNCoreErrorCatalog } from "./builtin.js";
export {
  createErrorDescriptor,
  ErrorDescriptorSchema,
  ResourceError,
  type ErrorDescriptor,
  type LocalizedError
} from "./errors.js";
export {
  loadLocaleCatalogFile,
  loadLocaleCatalogFileSync,
  loadPromptCatalogFile,
  loadPromptCatalogFileSync,
  parsePromptCatalog
} from "./loaders.js";
export {
  LocaleCatalogSchema,
  LocaleResolver,
  renderLocaleTemplate,
  type LocaleCatalog,
  type MissingLocaleKeyHandler
} from "./locale.js";
export {
  extractTemplateVariables,
  PromptDefinitionSchema,
  PromptRegistry,
  renderPrompt,
  type PromptDefinition,
  type ResolvedPromptDefinition
} from "./prompt.js";
