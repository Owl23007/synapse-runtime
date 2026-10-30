import { rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { parseConfigContent } from "../../src/config/index.js";
import { addChannelConfigFile, updateChannelConfigFile } from "../../src/config/channel-editor.js";

describe("控制台通道配置辅助函数", () => {
  it("更新并新增 TOML 配置中的通道", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-console-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "runtime.config.toml");
    writeFileSync(
      configPath,
      `[runtime]
logLevel = "info"

[channels."qq-official"]
adapter = "qq-official"
appId = "app-id"
appSecret = "app-secret"
enabled = false
`,
      "utf8"
    );

    await updateChannelConfigFile(configPath, "qq-official", { enabled: true });
    await addChannelConfigFile(configPath, "qq-extra", {
      adapter: "qq-official",
      appId: "extra-app-id",
      appSecret: "extra-secret",
      enabled: false
    });

    const config = parseConfigContent(readFileSync(configPath, "utf8"), configPath);

    expect(config.channels["qq-official"]?.enabled).toBe(true);
    expect(config.channels["qq-extra"]).toMatchObject({
      adapter: "qq-official",
      appId: "extra-app-id",
      enabled: false
    });
  });
});
