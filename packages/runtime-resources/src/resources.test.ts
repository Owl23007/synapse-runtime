import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocaleResolver,
  PromptDefinitionSchema,
  PromptRegistry,
  ResourceError,
  loadLocaleCatalogFileSync,
  loadPromptCatalogFileSync,
  zhCNCoreErrorCatalog
} from "./index.js";

describe("locale resources", () => {
  it("uses the fallback catalog and retains missing placeholders", () => {
    const resolver = new LocaleResolver([zhCNCoreErrorCatalog]);
    expect(resolver.localizeError({ code: "TIMEOUT", key: "agent.request_timeout" }, "en-US").message).toBe(
      "模型请求超时，请稍后重试。"
    );
    expect(resolver.resolve("unknown.key")).toBe("暂时无法提供此错误的说明，请稍后重试。");
    expect(resolver.resolve("runtime.configuration_invalid")).toContain("{reason}");
  });
  it("merges partial catalogs without discarding built-in messages", () => {
    const resolver = new LocaleResolver([zhCNCoreErrorCatalog]);
    resolver.add({ locale: "zh-CN", messages: { "agent.request_failed": "自定义失败提示。" } });

    expect(resolver.resolve("agent.request_failed")).toBe("自定义失败提示。");
    expect(resolver.resolve("admin.task_not_found")).toBe("未找到对应的任务。");
  });
});
describe("prompt registry", () => {
  const prompt = { id: "agent.reply", stage: "reasoning" as const, template: "任务：{{ task }}", variables: ["task"] };
  it("validates and renders declared variables", () => {
    const registry = new PromptRegistry([prompt]);
    expect(registry.render("agent.reply", { task: "测试" })).toBe("任务：测试");
    expect(() => registry.render("agent.reply", {})).toThrow(ResourceError);
    let caught: unknown;
    try {
      registry.render("agent.reply", {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResourceError);
    expect((caught as ResourceError).descriptor.code).toBe("PROMPT_VARIABLE_MISSING");
    expect(() => PromptDefinitionSchema.parse({ ...prompt, template: "{{ undeclared }}" })).toThrow(
      "undeclared variable"
    );
  });
  it("loads YAML and JSON catalogs synchronously", () => {
    const directory = mkdtempSync(join(tmpdir(), "resources-"));
    const localeFile = join(directory, "locale.yaml");
    const promptFile = join(directory, "prompts.json");
    writeFileSync(localeFile, "locale: zh-CN\nmessages:\n  hello: 你好，{name}\n");
    writeFileSync(promptFile, JSON.stringify({ prompts: [prompt] }));
    expect(loadLocaleCatalogFileSync(localeFile).messages.hello).toBe("你好，{name}");
    expect(loadPromptCatalogFileSync(promptFile).render("agent.reply", { task: "加载" })).toBe("任务：加载");
  });
});
