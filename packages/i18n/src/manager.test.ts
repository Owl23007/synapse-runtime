import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { checkTranslations, defineI18n, I18nManager, type TranslationKey } from "./index.js";

const english = {
  save: "Save {name}",
  count: { one: "{count} file", other: "{count} files" },
  amount: "{value, number}"
};
const create = () =>
  new I18nManager({ defaultLocale: "zh-CN", fallbackLocale: "en", supportedLocales: ["zh-CN", "en"] });

describe("modular internationalization", () => {
  it("does not load at registration and deduplicates concurrent requests", async () => {
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
  it("supports typed scoped keys, module imports and locale switching", async () => {
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
  it("returns missing keys in production and supports strict CI mode", () => {
    const manager = create();
    expect(manager.t("editor.absent")).toBe("editor.absent");
    const strict = new I18nManager({ defaultLocale: "en", fallbackLocale: "en", missingKey: "throw" });
    expect(() => strict.t("editor.absent")).toThrow(/Missing translation/);
  });
  it("rejects duplicate namespaces and missing canonical resources", () => {
    const manager = create();
    const definition = { namespace: "editor", canonicalLocale: "en", resources: { en: () => english } };
    manager.register(definition);
    expect(() => manager.register(definition)).toThrow(/conflict/);
    expect(() => manager.register({ ...definition, namespace: "other", resources: {} })).toThrow(/canonical/);
  });
  it("prevents an unloaded resource request from restoring stale cache", async () => {
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
  it("keeps the previous language after failed switch and permits retry", async () => {
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
  it("reports completeness and interpolation errors", () => {
    expect(checkTranslations({ save: "Save {name}", cancel: "Cancel" }, { save: "保存 {wrong}", old: "旧" })).toEqual([
      "invalid interpolation: save",
      "missing: cancel",
      "extra: old"
    ]);
  });
});
