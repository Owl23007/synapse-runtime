import { I18nManager } from "./manager.js";
import { z } from "zod";
import type { ErrorDescriptor, LocalizedError } from "./errors.js";

/** Locale Catalog 的结构校验规则 */
export const LocaleCatalogSchema = z.object({
  locale: z.string().min(1),
  messages: z.record(z.string().min(1))
});

/** 单一语言的本地化消息集合 */
export type LocaleCatalog = z.infer<typeof LocaleCatalogSchema>;

/** Locale Key 缺失时的可观测性回调 */
export type MissingLocaleKeyHandler = (event: { key: string; locale: string; fallbackLocale: string }) => void;

/** 面向结构化错误的 Catalog 视图，翻译与缓存统一委托国际化管理器 */
export class LocaleResolver {
  readonly i18n: I18nManager;
  readonly fallbackLocale: string;

  /** 宿主提供语言策略和资源，解析器不加载任何内置业务文案 */
  constructor(
    catalogs: readonly LocaleCatalog[] = [],
    locale = catalogs[0]?.locale ?? "en",
    onMissingKey?: MissingLocaleKeyHandler,
    fallbackLocale = locale
  ) {
    this.fallbackLocale = locale;
    this.i18n = new I18nManager({ defaultLocale: locale, fallbackLocale, ...(onMissingKey ? { onMissingKey } : {}) });
    for (const catalog of catalogs) this.add(catalog);
  }

  /** 合并宿主提供的资源覆盖，每个键按所属命名空间保存 */
  add(catalog: LocaleCatalog): this {
    const parsed = LocaleCatalogSchema.parse(catalog);
    const namespaces = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(parsed.messages)) {
      const separator = key.indexOf(".");
      const namespace = separator < 0 ? "messages" : key.slice(0, separator);
      const messages = namespaces.get(namespace) ?? {};
      messages[separator < 0 ? key : key.slice(separator + 1)] = value;
      namespaces.set(namespace, messages);
    }
    for (const [namespace, messages] of namespaces) this.i18n.addResource(namespace, parsed.locale, messages);
    return this;
  }

  /** 渲染错误消息；缺失时优先使用宿主提供的通用错误说明 */
  resolve(key: string, params: Record<string, string> = {}, locale = this.i18n.locale): string {
    const fullKey = key.includes(".") ? key : `messages.${key}`;
    const value = this.i18n.t(fullKey, params, locale);
    if (this.i18n.inspect(fullKey, locale).template !== undefined) return value;
    const fallback = this.i18n.inspect("locale.message_unavailable", locale);
    return fallback.template === undefined ? key : this.i18n.t("locale.message_unavailable", {}, locale);
  }

  /** 将结构化错误转换为宿主选择语言的用户可见消息 */
  localizeError(error: ErrorDescriptor, locale = this.i18n.locale): LocalizedError {
    return { ...error, locale, message: this.resolve(error.key, error.params, locale) };
  }
}

/** 渲染 Locale 模板并保留未提供值的占位符 */
export function renderLocaleTemplate(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => params[name] ?? match);
}
