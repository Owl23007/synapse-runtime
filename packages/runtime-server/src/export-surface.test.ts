import { describe, expect, it } from "vitest";

describe("runtime-server export surface", () => {
  it("keeps public runtime exports stable", async () => {
    const runtimeServer = await import("./index.js");

    expect(Object.keys(runtimeServer).sort()).toEqual([
      "DEFAULT_RUNTIME_ENDPOINT",
      "RuntimeAdminClient",
      "RuntimeServer",
      "connectProfile",
      "createAgentFromConfig",
      "createChannelAdapter",
      "createChatProvider",
      "getDefaultProfilePath",
      "loadEnvFile",
      "loadProfileConfig",
      "resolveRuntimeConnection",
      "saveProfileConfig",
      "startRuntimeServerFromConfigFile",
      "useProfile"
    ]);
  });

  it("keeps runtime-server deep imports compatible", async () => {
    await expect(import("./server/runtime-server.js")).resolves.toMatchObject({
      RuntimeServer: expect.any(Function),
      startRuntimeServerFromConfigFile: expect.any(Function)
    });
    await expect(import("./server/runtime-factory.js")).resolves.toMatchObject({
      createRuntimeFromConfig: expect.any(Function)
    });
    await expect(import("./server/admin/auth.js")).resolves.toMatchObject({ validateAdminSecurity: expect.any(Function) });
  });
});
