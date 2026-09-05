/** 国际化消息树，叶子为文本或复数分支 */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** 从模块默认资源推导点分隔的翻译键 */
export type TranslationKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : T[K] extends object ? `${K}.${TranslationKey<T[K]>}` : never;
}[keyof T & string];

/** 模块拥有的命名空间和按语言加载的资源 */
export interface I18nDefinition<T extends Messages = Messages> {
  readonly resourcePaths?: Readonly<Record<string, URL>>;
  readonly namespace: string;
  readonly canonicalLocale: string;
  readonly resources: Readonly<Record<string, () => T | { default: T } | Promise<T | { default: T }>>>;
}

/** 翻译插值参数 */
export type TranslationParams = Readonly<Record<string, string | number | Date>>;

/** 由宿主决定语言策略与缺失处理方式 */
export interface I18nOptions {
  readonly defaultLocale: string;
  readonly supportedLocales?: readonly string[];
  readonly fallbackLocale: string;
  readonly fallback?: Readonly<Record<string, readonly string[]>>;
  readonly missingKey?: "fallback" | "warn" | "throw";
  readonly onMissingKey?: (event: { key: string; locale: string; fallbackLocale: string }) => void;
}

/** 翻译查找记录，用于解释语言回退路径 */
export interface TranslationInspection {
  readonly key: string;
  readonly namespace: string;
  readonly requestedLocale: string;
  readonly resolvedLocale?: string;
  readonly template?: string;
}

/** 创建保留资源类型的国际化定义 */
export function defineI18n<T extends Messages>(definition: I18nDefinition<T>): I18nDefinition<T> {
  return Object.freeze({ ...definition });
}

/** 按命名空间管理懒加载、并发去重、缓存和语言切换，不认识业务模块 */
export class I18nManager {
  readonly #definitions = new Map<string, I18nDefinition>();
  readonly #cache = new Map<string, Messages>();
  readonly #pending = new Map<string, Promise<void>>();
  #locale: string;
  #switch = 0;

  constructor(readonly options: I18nOptions) {
    this.#locale = this.#normalize(options.defaultLocale);
  }

  /** 当前成功加载并激活的语言 */
  get locale(): string {
    return this.#locale;
  }

  /** 注册资源定义，此时不加载任何语言 */
  register<T extends Messages>(definition: I18nDefinition<T>): void {
    if (!definition.namespace || definition.namespace.includes(".")) throw new Error("Invalid i18n namespace");
    if (this.#definitions.has(definition.namespace)) throw new Error(`Namespace conflict: ${definition.namespace}`);
    if (!definition.resources[definition.canonicalLocale])
      throw new Error(`Missing canonical locale: ${definition.namespace}`);
    this.#definitions.set(definition.namespace, definition);
  }

  /** 卸载命名空间并释放缓存，旧加载任务无法覆盖后续注册 */
  unregister(namespace: string): void {
    this.#definitions.delete(namespace);
    for (const key of this.#cache.keys()) if (key.startsWith(`${namespace}\0`)) this.#cache.delete(key);
    for (const key of this.#pending.keys()) if (key.startsWith(`${namespace}\0`)) this.#pending.delete(key);
  }

  /** 注入宿主已经加载的资源，适用于 CLI 同步文件和用户覆盖 */
  addResource(namespace: string, locale: string, messages: Messages): void {
    const flat = flatten(messages);
    const key = `${namespace}\0${locale}`;
    this.#cache.set(key, Object.freeze({ ...this.#cache.get(key), ...flat }));
  }

  /** 只加载指定命名空间的当前语言及回退链，并发请求复用同一任务 */
  async load(namespace: string, locale = this.locale): Promise<void> {
    const definition = this.#definitions.get(namespace);
    if (!definition) throw new Error(`Unknown namespace: ${namespace}`);
    await Promise.all(
      this.#chain(locale).map(async (language) => {
        const loader = definition.resources[language];
        const key = `${namespace}\0${language}`;
        if (!loader || this.#cache.has(key)) return;
        let pending = this.#pending.get(key);
        if (!pending) {
          pending = Promise.resolve()
            .then(loader)
            .then((resource) => {
              const messages = typeof resource.default === "object" ? resource.default : resource;
              if (this.#definitions.get(namespace) === definition)
                this.addResource(namespace, language, messages as Messages);
              return undefined;
            })
            .catch((cause: unknown) => {
              throw new Error(`Locale load failed: ${namespace}/${language}`, { cause });
            });
          this.#pending.set(key, pending);
        }
        try {
          await pending;
        } finally {
          if (this.#pending.get(key) === pending) this.#pending.delete(key);
        }
      })
    );
  }

  /** 资源全部就绪后切换语言；失败或较早的并发切换不会改变当前语言 */
  async setLocale(locale: string): Promise<void> {
    const next = this.#normalize(locale);
    const generation = ++this.#switch;
    await Promise.all([...this.#definitions.keys()].map((namespace) => this.load(namespace, next)));
    if (generation === this.#switch) this.#locale = next;
  }

  /** 创建只访问自身命名空间的类型安全翻译器 */
  scope<T extends Messages>(
    definition: I18nDefinition<T>
  ): (key: TranslationKey<T>, params?: TranslationParams) => string;
  scope(namespace: string): (key: string, params?: TranslationParams) => string;
  scope(input: string | I18nDefinition): (key: string, params?: TranslationParams) => string {
    const namespace = typeof input === "string" ? input : input.namespace;
    return (key, params) => this.t(`${namespace}.${key}`, params);
  }

  /** 翻译已加载资源，支持插值、复数、数字和日期格式 */
  t(key: string, params: TranslationParams = {}, locale = this.locale): string {
    let result: TranslationInspection | undefined;
    for (const language of this.#chain(locale)) {
      if (typeof params.count === "number") {
        const category = new Intl.PluralRules(language).select(params.count);
        result = this.#lookup(`${key}.${category}`, locale, [language]);
        if (result.template === undefined) result = this.#lookup(`${key}.other`, locale, [language]);
      }
      if (result?.template === undefined) result = this.#lookup(key, locale, [language]);
      if (result.template !== undefined) break;
    }
    if (result?.template === undefined) {
      const event = { key, locale, fallbackLocale: this.options.fallbackLocale };
      this.options.onMissingKey?.(event);
      if (this.options.missingKey === "throw") throw new Error(`Missing translation: ${key} (${locale})`);
      if (this.options.missingKey === "warn" && !this.options.onMissingKey)
        console.warn(`Missing translation: ${key} (${locale})`);
      return key;
    }
    return result.template.replace(
      /\{([A-Za-z][A-Za-z0-9_]*)(?:,\s*(number|date))?\}/g,
      (match, name: string, format: string | undefined) => {
        const value = params[name];
        if (value === undefined) return match;
        if (format === "number" && typeof value === "number") return new Intl.NumberFormat(locale).format(value);
        if (format === "date" && value instanceof Date) return new Intl.DateTimeFormat(locale).format(value);
        return String(value);
      }
    );
  }

  /** 查看指定键实际使用的语言和模板 */
  inspect(key: string, locale = this.locale): TranslationInspection {
    return this.#lookup(key, locale, this.#chain(locale));
  }

  #lookup(key: string, locale: string, chain: readonly string[]): TranslationInspection {
    const separator = key.indexOf(".");
    const namespace = key.slice(0, separator);
    const localKey = key.slice(separator + 1);
    for (const language of chain) {
      const template = this.#cache.get(`${namespace}\0${language}`)?.[localKey];
      if (typeof template === "string")
        return { key, namespace, requestedLocale: locale, resolvedLocale: language, template };
    }
    return { key, namespace, requestedLocale: locale };
  }
  #chain(locale: string): string[] {
    return [
      ...new Set([locale, ...(this.options.fallback?.[locale] ?? [locale.split("-")[0]!]), this.options.fallbackLocale])
    ];
  }
  #normalize(locale: string): string {
    const canonical = Intl.getCanonicalLocales(locale)[0]!;
    const supported = this.options.supportedLocales;
    if (!supported || supported.includes(canonical)) return canonical;
    const base = canonical.split("-")[0]!;
    const match = supported.find((item) => item === base || item === `${base}-${new Intl.Locale(canonical).region}`);
    if (match) return match;
    throw new Error(`Unsupported locale: ${locale}`);
  }
}

/** 将消息树展平，拒绝无效叶子和有歧义的重复键 */
export function flatten(messages: Messages): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  function visit(value: unknown, prefix: string): void {
    if (typeof value === "string") {
      if (Object.hasOwn(result, prefix)) throw new Error(`Duplicate translation key: ${prefix}`);
      result[prefix] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!key || ["__proto__", "constructor", "prototype"].includes(key))
          throw new Error(`Invalid resource key: ${key}`);
        visit(item, prefix ? `${prefix}.${key}` : key);
      }
    } else throw new Error(`Invalid translation resource: ${prefix}`);
  }
  visit(messages, "");
  return result;
}

/** 对比标准语言与译文的键和插值参数，供 CI 使用 */
export function checkTranslations(canonical: Messages, translated: Messages): string[] {
  const source = flatten(canonical),
    target = flatten(translated);
  const issues: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) issues.push(`missing: ${key}`);
    else if (parameters(value) !== parameters(target[key])) issues.push(`invalid interpolation: ${key}`);
  }
  for (const key of Object.keys(target)) if (source[key] === undefined) issues.push(`extra: ${key}`);
  return issues;
}

function parameters(text: string): string {
  return [...text.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1])
    .toSorted()
    .join("|");
}
