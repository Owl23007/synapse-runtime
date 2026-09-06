import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultUserConfigPath } from "./paths.js";

describe("user config paths", () => {
  it("uses an explicit environment path before the user default", () => {
    expect(getDefaultUserConfigPath({ SYNAPSE_USER_CONFIG: "custom.toml" })).toBe("custom.toml");
    expect(getDefaultUserConfigPath({})).toBe(join(homedir(), ".synapse", "config.toml"));
  });
});
