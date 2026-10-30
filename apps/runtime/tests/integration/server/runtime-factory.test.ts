import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryChannelRegistry } from "@synapse/runtime-channel";
import { parseConfigObject } from "../../../src/config/index.js";
import { onTestFinished, describe, expect, it } from "vitest";
import { createRuntimeFromConfig } from "../../../src/server/runtime-factory.js";

describe("运行时配置装配", () => {
  it("注册配置的生产网页工具", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-runtime-factory-web-tools-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = parseConfigObject({
      runtime: { dataDir },
      tools: {
        web: {
          enabled: true,
          search: {
            provider: "brave",
            apiKey: "brave-key"
          }
        }
      }
    });

    try {
      const result = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });

      try {
        expect(result.tools.list().map((tool) => tool.name)).toEqual(["web.search", "web.fetch"]);
        expect(result.tools.list()[0]?.inputSchema).toMatchObject({
          required: ["query"]
        });
        expect(result.tools.list()[1]?.inputSchema).toMatchObject({
          required: ["url"]
        });
      } finally {
        result.contextStore.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("默认禁用生产网页工具", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-runtime-factory-no-web-tools-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = parseConfigObject({
      runtime: { dataDir }
    });

    try {
      const result = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });

      try {
        expect(result.tools.list()).toEqual([]);
      } finally {
        result.contextStore.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("配置的提示词用途缺失时拒绝启动", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-runtime-factory-prompt-purpose-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const catalogPath = join(dataDir, "prompts.yaml");
    writeFileSync(
      catalogPath,
      [
        "schemaVersion: 1",
        "prompts:",
        "  - id: runtime.core",
        "    stage: reasoning",
        "    template: core",
        "recipes:",
        "  - id: reasoning.other",
        "    purpose: reasoning.other",
        "    basePromptIds: [runtime.core]"
      ].join("\n")
    );
    const config = parseConfigObject({
      runtime: { dataDir },
      prompts: { enabled: true, catalogPath, defaultPurpose: "reasoning.chat_reply" }
    });

    try {
      expect(() =>
        createRuntimeFromConfig({ config, channels: new InMemoryChannelRegistry(), logger: silentLogger })
      ).toThrow(/does not define the default purpose/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("禁用提示词上下文时仍持久保存 SQLite 运行时状态", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "synapse-runtime-factory-context-disabled-"));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const databasePath = join(dataDir, "runtime-context.sqlite");
    const config = parseConfigObject({
      runtime: { dataDir },
      context: { enabled: false }
    });

    try {
      const first = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });
      const state = await first.contextStore.begin({
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "private",
        conversationId: "user-1",
        sourceEventId: "event-1",
        sourceEventType: "message.created"
      });
      await first.contextStore.update(state.id, { status: "processing" });
      first.contextStore.close();

      expect(existsSync(databasePath)).toBe(true);

      const second = createRuntimeFromConfig({
        config,
        channels: new InMemoryChannelRegistry(),
        logger: silentLogger
      });

      try {
        await expect(
          second.contextStore.begin({
            platform: "qq",
            provider: "napcat",
            channelId: "qq-local",
            conversationType: "private",
            conversationId: "user-1",
            sourceEventId: "event-1",
            sourceEventType: "message.created"
          })
        ).resolves.toMatchObject({ id: state.id, status: "processing" });
      } finally {
        second.contextStore.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};
