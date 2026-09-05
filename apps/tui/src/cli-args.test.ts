import { describe, expect, it } from "vitest";
import { parseTuiArgs } from "./cli-args.js";

const help = (): never => {
  throw new Error("help");
};
describe("standalone TUI arguments", () => {
  it("separates remote connection from owned process configuration", () => {
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
