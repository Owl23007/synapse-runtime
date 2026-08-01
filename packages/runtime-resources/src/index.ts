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
  loadPresentationProfileCatalogFile,
  loadPresentationProfileCatalogFileSync,
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
  PresentationProfileCatalogSchema,
  PresentationProfileSchema,
  resolvePresentationProfile,
  type PresentationProfile,
  type PresentationProfileCatalog
} from "./presentation.js";
export {
  extractTemplateVariables,
  PromptDefinitionSchema,
  PromptRegistry,
  renderPrompt,
  type PromptDefinition,
  type ResolvedPromptDefinition
} from "./prompt.js";
