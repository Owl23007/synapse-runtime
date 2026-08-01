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

/** 负责 Catalog 合并、语言回退和模板渲染的解析器 */
export class LocaleResolver {
  private readonly catalogs = new Map<string, LocaleCatalog>();
  readonly fallbackLocale: string;

  private readonly onMissingKey: MissingLocaleKeyHandler | undefined;

  /** 使用给定 Catalog 和默认回退语言创建解析器 */
  constructor(
    catalogs: readonly LocaleCatalog[] = [],
    fallbackLocale = "zh-CN",
    onMissingKey?: MissingLocaleKeyHandler
  ) {
    this.fallbackLocale = fallbackLocale;
    this.onMissingKey = onMissingKey;
    for (const catalog of catalogs) this.add(catalog);
  }

  /** 合并同语言 Catalog，后加入的同名 Key 覆盖内置值 */
  add(catalog: LocaleCatalog): this {
    const parsed = LocaleCatalogSchema.parse(catalog);
    const existing = this.catalogs.get(parsed.locale);
    this.catalogs.set(
      parsed.locale,
      existing === undefined
        ? parsed
        : {
            locale: parsed.locale,
            messages: { ...existing.messages, ...parsed.messages }
          }
    );
    return this;
  }

  /** 解析指定 Key 并插入安全参数 */
  resolve(key: string, params: Record<string, string> = {}, locale = this.fallbackLocale): string {
    const template = this.catalogs.get(locale)?.messages[key] ?? this.catalogs.get(this.fallbackLocale)?.messages[key];
    if (template === undefined) {
      this.onMissingKey?.({ key, locale, fallbackLocale: this.fallbackLocale });
      // 缺失 Key 不直接回显内部标识，避免把实现细节暴露给用户
      return "暂时无法提供此错误的说明，请稍后重试。";
    }
    return renderLocaleTemplate(template, params);
  }

  /** 将结构化错误转换为指定语言的用户可见错误 */
  localizeError(error: ErrorDescriptor, locale = this.fallbackLocale): LocalizedError {
    return { ...error, locale, message: this.resolve(error.key, error.params, locale) };
  }
}

/** 渲染 Locale 模板并保留未提供值的占位符 */
export function renderLocaleTemplate(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) => params[name] ?? match);
}
