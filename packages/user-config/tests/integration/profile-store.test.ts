import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_ENDPOINT,
  connectProfile,
  loadProfileConfig,
  resolveRuntimeConnection,
  useProfile
} from "../../src/profile-store.js";

describe("运行时命令行配置档案", () => {
  it("连接端点、切换当前档案并持久保存命令行配置", async () => {
    const profilePath = tempProfilePath();

    await connectProfile({
      endpoint: "http://127.0.0.1:3766",
      profilePath
    });
    await connectProfile({
      endpoint: "https://runtime.example.com",
      token: "prod-token",
      profile: "prod",
      profilePath
    });
    await useProfile("prod", profilePath);

    await expect(loadProfileConfig(profilePath)).resolves.toEqual({
      current: "prod",
      profiles: {
        local: {
          endpoint: "http://127.0.0.1:3766"
        },
        prod: {
          endpoint: "https://runtime.example.com",
          token: "prod-token"
        }
      }
    });
    await expect(readFile(profilePath, "utf8")).resolves.toContain('"current": "prod"');
  });

  it("按显式端点、档案、环境、当前档案与默认值顺序解析连接", async () => {
    const profilePath = tempProfilePath();
    await connectProfile({
      endpoint: "http://local.example.test",
      profile: "local",
      profilePath
    });
    await connectProfile({
      endpoint: "https://prod.example.test",
      token: "profile-token",
      profile: "prod",
      profilePath
    });

    await expect(resolveRuntimeConnection({ endpoint: "http://override.test", profilePath })).resolves.toEqual({
      endpoint: "http://override.test"
    });
    await expect(resolveRuntimeConnection({ profile: "prod", profilePath })).resolves.toEqual({
      endpoint: "https://prod.example.test",
      token: "profile-token",
      profile: "prod"
    });
    await expect(
      resolveRuntimeConnection({
        profilePath,
        env: {
          SYNAPSE_RUNTIME_URL: "https://env.example.test",
          SYNAPSE_RUNTIME_TOKEN: "env-token"
        }
      })
    ).resolves.toEqual({
      endpoint: "https://env.example.test",
      token: "env-token"
    });
    await expect(resolveRuntimeConnection({ profilePath })).resolves.toEqual({
      endpoint: "https://prod.example.test",
      token: "profile-token",
      profile: "prod"
    });
    await expect(resolveRuntimeConnection({ profilePath: tempProfilePath(), env: {} })).resolves.toEqual({
      endpoint: DEFAULT_RUNTIME_ENDPOINT
    });
  });
});

function tempProfilePath(): string {
  return join(mkdtempSync(join(tmpdir(), "synapse-cli-profile-")), "cli.json");
}
