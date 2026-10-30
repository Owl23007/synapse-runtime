import { describe, expect, it } from "vitest";
import { parseTuiArgs } from "../../src/cli-args.js";

const help = (): never => {
  throw new Error("help");
};
describe("独立 TUI 参数", () => {
  it("区分远程连接与自有进程配置", () => {
    expect(
      parseTuiArgs(["--endpoint", "http://localhost:3766", "--profile-config", "profiles.json"], help)
    ).toMatchObject({ endpoint: "http://localhost:3766", profilePath: "profiles.json" });
    expect(
      parseTuiArgs(["--spawn", "--runtime-entry", "runtime/cli.js", "--config", "runtime.json"], help)
    ).toMatchObject({ spawn: true, runtimeEntry: "runtime/cli.js", configPath: "runtime.json" });
    expect(() => parseTuiArgs(["--spawn"], help)).toThrow("--runtime-entry");
    expect(() => parseTuiArgs(["--config", "remote.json"], help)).toThrow("require --spawn");
    expect(() =>
      parseTuiArgs(["--spawn", "--runtime-entry", "runtime.js", "--endpoint", "http://localhost"], help)
    ).toThrow("remote connection");
    expect(() => parseTuiArgs(["--token", "--spawn"], help)).toThrow("requires a value");
  });
});
