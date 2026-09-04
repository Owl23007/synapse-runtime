import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.js";

const failOnHelp = (): never => {
  throw new Error("help requested");
};

describe("parseArgs", () => {
  it("uses the start command and default config path", () => {
    expect(parseArgs([], failOnHelp)).toEqual({ command: "start", configPath: "runtime.config.toml" });
  });

  it("parses shared options and command aliases", () => {
    expect(
      parseArgs(
        [
          "serve",
          "--config",
          "config.toml",
          "--env-file",
          ".env.test",
          "--admin-host",
          "127.0.0.1",
          "--admin-port",
          "0",
          "--admin-token-env",
          "ADMIN_TOKEN",
          "--tail",
          "25",
          "--spawn"
        ],
        failOnHelp
      )
    ).toEqual({
      command: "serve",
      configPath: "config.toml",
      envFile: ".env.test",
      adminHost: "127.0.0.1",
      adminPort: 0,
      adminTokenEnv: "ADMIN_TOKEN",
      tail: 25,
      spawn: true
    });
  });

  it("supports positional values for profile commands", () => {
    expect(parseArgs(["connect", "http://127.0.0.1:3766"], failOnHelp)).toMatchObject({
      command: "connect",
      endpoint: "http://127.0.0.1:3766"
    });
    expect(parseArgs(["use", "prod"], failOnHelp)).toMatchObject({ command: "use", profile: "prod" });
  });

  it("validates channel commands and numeric options", () => {
    expect(parseArgs(["channel", "enable", "qq"], failOnHelp)).toMatchObject({
      command: "channel",
      channelAction: "enable",
      channelId: "qq"
    });
    expect(() => parseArgs(["channel", "pause", "qq"], failOnHelp)).toThrow(
      'channel command requires "enable" or "disable".'
    );
    expect(() => parseArgs(["logs", "--limit", "0"], failOnHelp)).toThrow("--limit requires a positive integer.");
  });

  it("rejects options without values and unknown arguments", () => {
    expect(() => parseArgs(["--token"], failOnHelp)).toThrow("--token requires a token.");
    expect(() => parseArgs(["--unknown"], failOnHelp)).toThrow('Unknown argument "--unknown".');
  });
});
