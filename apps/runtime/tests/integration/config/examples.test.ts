import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parseConfigFileContent } from "@synapse/runtime-config/node";
import { compilePromptBundleFileSync } from "@synapse/runtime-resources";
import { onTestFinished, describe, expect, it } from "vitest";
import { createLocaleResolverFromConfig } from "../../../src/composition/runtime-resources.js";
import { loadConfigFile } from "../../../src/config/loader.js";

const root = fileURLToPath(new URL("../../../../..", import.meta.url));
const examples = readdirSync(join(root, "examples")).filter((name) => name.endsWith(".config.toml"));
const templateEnv = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
const env = {
  ...templateEnv,
  QWEN_API_KEY: "test-qwen-key",
  QQ_BOT_APP_ID: "test-app-id",
  QQ_BOT_APP_SECRET: "test-app-secret",
  MODEL_API_KEY: "test-model-key",
  NAPCAT_TOKEN: "test-napcat-token",
  QQ_BOT_ID: "123456"
};
const logger = { info() {}, warn() {}, error() {} };

function variables(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!);
  if (Array.isArray(value)) return value.flatMap(variables);
  return value !== null && typeof value === "object" ? Object.values(value).flatMap(variables) : [];
}

describe("部署示例契约", () => {
  it.each(examples)("示例环境文件声明 %s 中所有生效变量", (name) => {
    const path = join(root, "examples", name);
    const raw = parseConfigFileContent(readFileSync(path, "utf8"), path);
    expect([...new Set(variables(raw))].filter((variable) => !Object.hasOwn(templateEnv, variable))).toEqual([]);
  });

  it("完整示例使用本地配置并在用户配置前禁用所有通道", async () => {
    const config = await loadConfigFile(join(root, "examples/runtime.config.toml"), { env });
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.admin.host).toBe("127.0.0.1");
    expect(Object.values(config.channels).every((channel) => !channel.enabled)).toBe(true);
  });

  it.each(examples)("加载 %s 复制后的配置、语言和提示词资源", async (name) => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-example-deployment-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    try {
      const configPath = join(directory, "runtime.config.toml");
      cpSync(join(root, "examples", name), configPath);
      cpSync(join(root, "examples/resources"), join(directory, "resources"), { recursive: true });
      const config = await loadConfigFile(configPath, { env });
      const locale = createLocaleResolverFromConfig(config, logger);
      expect(locale.resolve("agent.request_failed")).toBe("模型请求失败，请稍后重试。");
      expect(config.prompts.enabled).toBe(name !== "minimal.config.toml");
      if (!config.prompts.enabled) return;
      expect(config.prompts.catalogPath).toBe(join(directory, "resources/prompts.zh-CN.yaml"));
      const compiler = compilePromptBundleFileSync(config.prompts.catalogPath!, {
        locale: config.locale.default,
        contextStrategy: config.context.strategy,
        runtimeName: "Synapse Runtime"
      });
      expect(compiler.hasPurpose(config.prompts.defaultPurpose!)).toBe(true);
      for (const purpose of [config.prompts.defaultPurpose!, "reasoning.task_execute"]) {
        for (const conversationKind of ["private", "group", "channel", "unknown"]) {
          for (const lineKind of ["mainline", "branch"]) {
            const invocation = compiler.compile({
              purpose,
              dimensions: { conversationKind, lineKind },
              toolIds: [],
              toolSetDigest: "no-tools"
            });
            expect(invocation.prompt.blocks.length).toBeGreaterThan(0);
            expect(invocation.capabilities.toolIds).toEqual([]);
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
