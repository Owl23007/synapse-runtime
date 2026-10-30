import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { checkTranslations, defineI18n, I18nManager, type TranslationKey } from "../../src/index.js";

const english = {
  save: "Save {name}",
  count: { one: "{count} file", other: "{count} files" },
  amount: "{value, number}"
};
const create = () =>
  new I18nManager({ defaultLocale: "zh-CN", fallbackLocale: "en", supportedLocales: ["zh-CN", "en"] });

describe("模块化国际化", () => {
  it("注册时不加载资源并合并并发请求", async () => {
    const en = vi.fn<() => Promise<typeof english>>(async () => english),
      zh = vi.fn<() => Promise<{ save: string }>>(async () => ({ save: "保存 {name}" }));
    const manager = create();
    manager.register({ namespace: "editor", canonicalLocale: "en", resources: { en, "zh-CN": zh } });
    expect(en).not.toHaveBeenCalled();
    await Promise.all([manager.load("editor"), manager.load("editor")]);
    expect(en).toHaveBeenCalledTimes(1);
    expect(zh).toHaveBeenCalledTimes(1);
    expect(manager.scope("editor")("save", { name: "A" })).toBe("保存 A");
    expect(manager.t("editor.count", { count: 2 })).toBe("2 files");
    await manager.load("editor");
    expect(en).toHaveBeenCalledTimes(1);
  });
  it("支持带类型的作用域键、模块导入与语言切换", async () => {
    const definition = defineI18n({
      namespace: "editor",
      canonicalLocale: "en",
      resources: { en: async () => ({ default: english }) }
    });
    const manager = create();
    manager.register(definition);
    await manager.setLocale("en");
    const t = manager.scope(definition);
    expectTypeOf<Parameters<typeof t>[0]>().toEqualTypeOf<TranslationKey<typeof english>>();
    expect(t("save", { name: "B" })).toBe("Save B");
    expect(manager.t("editor.count", { count: 1 })).toBe("1 file");
    expect(manager.t("editor.amount", { value: 1200 })).toBe("1,200");
    expect(manager.inspect("editor.save")).toMatchObject({ resolvedLocale: "en", namespace: "editor" });
  });
  it("生产环境返回缺失键且支持严格 CI 模式", () => {
    const manager = create();
    expect(manager.t("editor.absent")).toBe("editor.absent");
    const strict = new I18nManager({ defaultLocale: "en", fallbackLocale: "en", missingKey: "throw" });
    expect(() => strict.t("editor.absent")).toThrow(/Missing translation/);
  });
  it("拒绝重复命名空间与缺失的标准资源", () => {
    const manager = create();
    const definition = { namespace: "editor", canonicalLocale: "en", resources: { en: () => english } };
    manager.register(definition);
    expect(() => manager.register(definition)).toThrow(/conflict/);
    expect(() => manager.register({ ...definition, namespace: "other", resources: {} })).toThrow(/canonical/);
  });
  it("防止已卸载资源的请求恢复过期缓存", async () => {
    const manager = create();
    let complete!: (value: typeof english) => void;
    manager.register({
      namespace: "editor",
      canonicalLocale: "en",
      resources: {
        en: () =>
          new Promise<typeof english>((resolve) => {
            complete = resolve;
          })
      }
    });
    const loading = manager.load("editor");
    await Promise.resolve();
    manager.unregister("editor");
    manager.register({ namespace: "editor", canonicalLocale: "en", resources: { en: () => ({ save: "New" }) } });
    await manager.load("editor");
    complete(english);
    await loading;
    expect(manager.t("editor.save")).toBe("New");
  });
  it("语言切换失败后保留原语言且允许重试", async () => {
    let fail = true;
    const manager = create();
    manager.register({
      namespace: "editor",
      canonicalLocale: "en",
      resources: {
        en: () => {
          if (fail) throw new Error("network");
          return english;
        }
      }
    });
    await expect(manager.setLocale("en")).rejects.toThrow(/Locale load failed/);
    expect(manager.locale).toBe("zh-CN");
    fail = false;
    await manager.setLocale("en");
    expect(manager.locale).toBe("en");
  });
  it("报告完整性与插值错误", () => {
    expect(checkTranslations({ save: "Save {name}", cancel: "Cancel" }, { save: "保存 {wrong}", old: "旧" })).toEqual([
      "invalid interpolation: save",
      "missing: cancel",
      "extra: old"
    ]);
  });
});
