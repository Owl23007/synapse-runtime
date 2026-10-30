import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigObject } from "../../../src/config/index.js";
import { onTestFinished, describe, expect, it } from "vitest";
import {
  createLocaleResolverFromConfig,
  createPresentationProfileFromConfig
} from "../../../src/composition/runtime-resources.js";

describe("运行时展示资源", () => {
  it("配置英语语言时使用内置英文消息", () => {
    const config = parseConfigObject({ locale: { default: "en-US" } });
    const resolver = createLocaleResolverFromConfig(config, { info() {}, warn() {}, error() {} });

    expect(resolver.resolve("admin.task_not_found")).toBe("The requested task was not found.");
  });

  it("装配时加载选定的确定性展示配置", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-presentation-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const profilePath = join(directory, "profiles.yaml");
    writeFileSync(profilePath, "profiles:\n  - id: concise\n    maxChars: 600\n");
    const config = parseConfigObject({
      presentation: { mode: "deterministic", profilePath, defaultProfileId: "concise" }
    });

    expect(createPresentationProfileFromConfig(config)).toMatchObject({
      id: "concise",
      enabled: true,
      locale: "zh-CN",
      maxChars: 600
    });
  });

  it("选定的展示配置不可用时终止启动装配", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-presentation-missing-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const profilePath = join(directory, "profiles.yaml");
    writeFileSync(profilePath, "profiles:\n  - id: default\n");
    const config = parseConfigObject({
      presentation: { mode: "deterministic", profilePath, defaultProfileId: "missing" }
    });

    expect(() => createPresentationProfileFromConfig(config)).toThrow("presentation.profile_not_found");
  });
});
