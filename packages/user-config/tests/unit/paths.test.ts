import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultUserConfigPath } from "../../src/paths.js";

describe("用户配置路径", () => {
  it("优先使用显式环境路径再使用用户默认路径", () => {
    expect(getDefaultUserConfigPath({ SYNAPSE_USER_CONFIG: "custom.toml" })).toBe("custom.toml");
    expect(getDefaultUserConfigPath({})).toBe(join(homedir(), ".synapse", "config.toml"));
  });
});
