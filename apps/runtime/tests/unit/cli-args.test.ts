import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli-args.js";

const failOnHelp = (): never => {
  throw new Error("help requested");
};

describe("命令行参数解析", () => {
  it("默认使用启动命令与默认配置路径", () => {
    expect(parseArgs([], failOnHelp)).toEqual({ command: "start", configPath: "runtime.config.toml" });
  });

  it("解析共享选项与命令别名", () => {
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

  it("支持配置档案命令的位置参数", () => {
    expect(parseArgs(["connect", "http://127.0.0.1:3766"], failOnHelp)).toMatchObject({
      command: "connect",
      endpoint: "http://127.0.0.1:3766"
    });
    expect(parseArgs(["use", "prod"], failOnHelp)).toMatchObject({ command: "use", profile: "prod" });
  });

  it("校验通道命令与数值选项", () => {
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

  it("拒绝缺少值的选项与未知参数", () => {
    expect(() => parseArgs(["--token"], failOnHelp)).toThrow("--token requires a token.");
    expect(() => parseArgs(["--unknown"], failOnHelp)).toThrow('Unknown argument "--unknown".');
  });
});
