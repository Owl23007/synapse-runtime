import { loadLocaleCatalogFileSync } from "@synapse/runtime-i18n/node";
import { loadApplicationCatalog } from "../../../src/composition/locales.js";
const enCoreErrorCatalog = loadApplicationCatalog("en");
const zhCNCoreErrorCatalog = loadApplicationCatalog("zh-CN");
import { LocaleResolver } from "@synapse/runtime-i18n";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import {
  PromptBundleCompiler,
  PresentationProfileCatalogSchema,
  PromptDefinitionSchema,
  PromptRegistry,
  ResourceError,
  loadPresentationProfileCatalogFileSync,
  loadPromptCatalogFileSync
} from "@synapse/runtime-resources";

describe("语言资源", () => {
  it("使用回退词条并保留缺失占位符", () => {
    const resolver = new LocaleResolver([zhCNCoreErrorCatalog, enCoreErrorCatalog]);
    expect(resolver.localizeError({ code: "TIMEOUT", key: "agent.request_timeout" }, "en-US").message).toBe(
      "The model request timed out. Please try again later."
    );
    expect(resolver.resolve("unknown.key")).toBe("暂时无法提供此错误的说明，请稍后重试。");
    expect(resolver.resolve("runtime.configuration_invalid")).toContain("{reason}");
  });
  it("为英语语言标签提供内置英文消息", () => {
    const resolver = new LocaleResolver([zhCNCoreErrorCatalog, enCoreErrorCatalog], "en-US");

    expect(resolver.resolve("agent.request_timeout")).toBe("The model request timed out. Please try again later.");
    expect(resolver.resolve("agent.request_timeout", {}, "en")).toBe(
      "The model request timed out. Please try again later."
    );
    expect(resolver.resolve("unknown.key")).toBe(
      "A description for this error is temporarily unavailable. Please try again later."
    );
  });
  it("合并部分词条时保留内置消息", () => {
    const resolver = new LocaleResolver([zhCNCoreErrorCatalog]);
    resolver.add({ locale: "zh-CN", messages: { "agent.request_failed": "自定义失败提示。" } });

    expect(resolver.resolve("agent.request_failed")).toBe("自定义失败提示。");
    expect(resolver.resolve("admin.task_not_found")).toBe("未找到对应的任务。");
  });
});

describe("展示配置", () => {
  it("加载确定性展示配置并拒绝行为指令", () => {
    const directory = mkdtempSync(join(tmpdir(), "presentation-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const profileFile = join(directory, "profiles.yaml");
    writeFileSync(
      profileFile,
      "profiles:\n  - id: concise\n    locale: zh-CN\n    maxChars: 600\n    maxParagraphs: 2\n"
    );

    expect(loadPresentationProfileCatalogFileSync(profileFile).profiles[0]).toMatchObject({
      id: "concise",
      enabled: true,
      maxChars: 600
    });
    expect(() =>
      PresentationProfileCatalogSchema.parse({
        profiles: [{ id: "unsafe", locale: "zh-CN", behavior: "always call tools" }]
      })
    ).toThrow();
  });

  it("拒绝重复的展示配置标识", () => {
    expect(() => PresentationProfileCatalogSchema.parse({ profiles: [{ id: "default" }, { id: "default" }] })).toThrow(
      /Duplicate presentation profile id/
    );
  });
});
describe("提示词注册表", () => {
  const prompt = { id: "agent.reply", stage: "reasoning" as const, template: "任务：{{ task }}", variables: ["task"] };
  it("校验并渲染声明的变量", () => {
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
  it("同步加载 YAML 和 JSON 词条", () => {
    const directory = mkdtempSync(join(tmpdir(), "resources-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const localeFile = join(directory, "locale.yaml");
    const promptFile = join(directory, "prompts.json");
    writeFileSync(localeFile, "locale: zh-CN\nmessages:\n  hello: 你好，{name}\n");
    writeFileSync(promptFile, JSON.stringify({ prompts: [prompt] }));
    expect(loadLocaleCatalogFileSync(localeFile).messages.hello).toBe("你好，{name}");
    expect(loadPromptCatalogFileSync(promptFile).render("agent.reply", { task: "加载" })).toBe("任务：加载");
  });
});

describe("提示词包编译", () => {
  const compiler = new PromptBundleCompiler(
    {
      prompts: [
        {
          id: "runtime.core",
          stage: "reasoning",
          slot: "runtime",
          stablePrefix: true,
          cacheScope: "global",
          variables: ["runtimeName"],
          template: "Runtime={{ runtimeName }}"
        },
        { id: "chat.group", stage: "reasoning", slot: "scene", template: "群聊边界" },
        { id: "skill.review", stage: "reasoning", slot: "skill", template: "执行代码审查流程" }
      ],
      recipes: [
        {
          id: "reasoning.chat",
          purpose: "reasoning.chat_reply",
          basePromptIds: ["runtime.core"],
          dimensions: { conversationKind: { group: ["chat.group"] } }
        }
      ],
      skills: [
        {
          id: "repository.review",
          description: "审查仓库变更",
          purposes: ["reasoning.chat_reply"],
          activation: { mode: "scene", dimensions: { taskKind: ["code_review"] } },
          promptIds: ["skill.review"],
          requiredTools: ["repository.diff"],
          allowedTools: ["repository.diff"]
        }
      ]
    },
    { runtimeName: "Synapse" }
  );

  it("组合维度与已激活技能并收窄可见工具", () => {
    const invocation = compiler.compile({
      purpose: "reasoning.chat_reply",
      dimensions: { conversationKind: "group", taskKind: "code_review" },
      toolIds: ["filesystem.write", "repository.diff"],
      toolSetDigest: "tools-v1"
    });

    expect(invocation.prompt.blocks.map((block) => block.promptId)).toEqual([
      "runtime.core",
      "chat.group",
      "skill.review"
    ]);
    expect(invocation.capabilities.toolIds).toEqual(["repository.diff"]);
    expect(invocation.capabilities.activeSkills).toEqual([
      expect.objectContaining({ id: "repository.review", reason: "scene" })
    ]);
    expect(
      compiler.compile({
        purpose: "reasoning.chat_reply",
        dimensions: { conversationKind: "group", taskKind: "code_review" },
        toolIds: ["repository.diff", "filesystem.write"],
        toolSetDigest: "tools-v1"
      })
    ).toBe(invocation);
  });

  it("激活的技能缺少必需工具时拒绝编译", () => {
    expect(() =>
      compiler.compile({
        purpose: "reasoning.chat_reply",
        dimensions: { conversationKind: "group", taskKind: "code_review" },
        toolIds: [],
        toolSetDigest: "empty"
      })
    ).toThrow(ResourceError);
  });
});
