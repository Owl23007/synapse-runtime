import { describe, expect, it } from "vitest";

describe("runtime-core export surface", () => {
  it("keeps public runtime exports stable", async () => {
    const runtimeCore = await import("./index.js");

    expect(Object.keys(runtimeCore).toSorted()).toEqual([
      "ContextComposer",
      "IdentityResolverLite",
      "InMemoryEventProcessStore",
      "InMemoryTranscriptStore",
      "OutputPolicyResolver",
      "ResponsePolicy",
      "RuntimeCore",
      "SqliteRuntimeContextStore",
      "WorkspaceResolverLite",
      "anonymousActor",
      "buildSessionId",
      "buildSourceEventId",
      "commandResponse",
      "conversationTypeFromEvent",
      "defaultWorkspace",
      "normalizeMessageId"
    ]);
  });

  it("keeps context deep imports compatible", async () => {
    await expect(import("./context.js")).resolves.toMatchObject({
      ContextComposer: expect.any(Function),
      InMemoryTranscriptStore: expect.any(Function),
      SqliteRuntimeContextStore: expect.any(Function)
    });
    await expect(import("./context/index.js")).resolves.toMatchObject({ ContextComposer: expect.any(Function) });
    await expect(import("./storage/sqlite/index.js")).resolves.toMatchObject({
      SqliteRuntimeContextStore: expect.any(Function)
    });
  });
});
