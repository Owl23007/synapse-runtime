import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";
import { CapabilityService } from "./service.js";
import type { RunDependencySnapshot } from "./types.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synapse-caps-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const context = new SqliteRuntimeContextStore({ databasePath: join(root, "runtime.sqlite") });
  cleanup.push(() => context.close());
  for (const id of ["a", "b"])
    await context.resolveWorkspace({
      platform: "qq",
      provider: "napcat",
      channelId: "qq",
      conversationType: "group",
      conversationId: id,
      identityId: "actor",
      defaultWorkspace: { id, type: "group", name: id }
    });
  const fetch = async () => {
    throw new Error("network should not be used");
  };
  const service = new CapabilityService(context.capabilities, join(root, "installed"), [], fetch, ["github"]);
  const install = (version: string) => {
    const directory = join(root, version);
    mkdirSync(directory);
    writeFileSync(join(directory, "SKILL.md"), `---\nname: reports\ndescription: 分析报告\n---\n${version}`);
    return service.registerDirectory(directory, "runtime:reports", "admin");
  };
  return { context, service, install, root };
}
describe("versioned workspace capabilities", () => {
  it("installs pinned catalog handoffs, ignores supplied archive URLs, and reads snapshots offline", async () => {
    const { context, root } = await fixture();
    const archive = Uint8Array.from(
      Buffer.from(
        "UEsDBBQAAAAIALRgXl3jQY45RwAAAEsAAAAgAAAAcmVwby1zaGEvc2tpbGxzL3JlcG9ydHMvU0tJTEwubWQdysENgCAMBdA7U7BA9c4YbtDQr2kihbR4cHuJ15dHRMm4oWTH6D4jCaK6jqndSj5+zGx8v6GRaPUDLGufcFhF7Nejgq3JB1BLAwQUAAAACAC0YF5dW6Bjxg8AAAANAAAAKwAAAHJlcG8tc2hhL3NraWxscy9yZXBvcnRzL3JlZmVyZW5jZXMvZ3VpZGUubWTzT0vLycxLVUgvzUxJBQBQSwECFAAUAAAACAC0YF5d40GOOUcAAABLAAAAIAAAAAAAAAAAAAAAgAEAAAAAcmVwby1zaGEvc2tpbGxzL3JlcG9ydHMvU0tJTEwubWRQSwECFAAUAAAACAC0YF5dW6Bjxg8AAAANAAAAKwAAAAAAAAAAAAAAgAGFAAAAcmVwby1zaGEvc2tpbGxzL3JlcG9ydHMvcmVmZXJlbmNlcy9ndWlkZS5tZFBLBQYAAAAAAgACAKcAAADdAAAAAAA=",
        "base64"
      )
    );
    const requests: string[] = [];
    let offline = false;
    const service = new CapabilityService(
      context.capabilities,
      join(root, "downloads"),
      [
        {
          id: "clawhub",
          async search() {
            return { items: [] };
          },
          async versions() {
            return { items: [{ version: "1.0.0" }, { version: "1.1.0" }] };
          },
          async get(_id, version) {
            return {
              provider: "clawhub",
              packageId: "owner/reports",
              name: "reports",
              description: "Report analysis",
              version: version ?? "1.1.0"
            };
          }
        }
      ],
      async (input) => {
        if (offline) throw new Error("catalog offline");
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://clawhub.ai/"))
          return Response.json({
            sourceRef: "public-github",
            repo: "owner/repo",
            commit: "a".repeat(40),
            path: "skills/reports",
            contentHash: "source-observed",
            archiveUrl: "http://127.0.0.1/secret"
          });
        expect(url).toBe(`https://codeload.github.com/owner/repo/zip/${"a".repeat(40)}`);
        return new Response(archive);
      },
      ["clawhub", "github"]
    );
    const first = await service.install({ provider: "clawhub", packageId: "owner/reports", version: "1.0.0" }, "admin");
    expect(first.sourceRevision).toBe("a".repeat(40));
    expect(new URL(requests[0]!).searchParams.get("ownerHandle")).toBe("owner");
    expect(context.capabilities.bindings("a")).toEqual([]);
    service.bind("a", first.packageKey, { installId: first.id, enabled: true }, "admin");
    const second = await service.install(
      { provider: "clawhub", packageId: "owner/reports", version: "1.1.0" },
      "admin"
    );
    expect(second.id).not.toBe(first.id);
    expect(second.contentDigest).toBe(first.contentDigest);
    expect(service.enabled("a")[0]?.id).toBe(first.id);
    offline = true;
    expect(service.loader(first.id).readResource("references/guide.md")).toMatchObject({ text: "Offline guide" });
    expect(requests).toHaveLength(4);
  });
  it("isolates workspace enables, pins running versions, supports rollback, and revokes disabled bindings", async () => {
    const { context, service, install } = await fixture();
    const first = install("v1");
    const second = install("v2");
    service.bind("a", first.packageKey, { installId: first.id, enabled: true }, "admin");
    expect(service.enabled("b")).toEqual([]);
    expect(service.enabled("a").map((value) => value.id)).toEqual([first.id]);
    const snapshot: RunDependencySnapshot = {
      workspaceId: "a",
      assets: [],
      skills: [{ installId: first.id, contentDigest: first.contentDigest }],
      toolSetDigest: "tools",
      skillSetDigest: "skills",
      mcpConnections: []
    };
    context.capabilities.pin("run-one", snapshot, [first.id]);
    service.bind("a", first.packageKey, { installId: second.id, enabled: true }, "admin");
    expect(service.enabled("a").map((value) => value.id)).toEqual([second.id]);
    expect(context.capabilities.canUse("a", second.id, "run-one")).toBe(false);
    expect(service.enabled("a", "run-one").map((value) => value.id)).toEqual([first.id]);
    service.bind("a", first.packageKey, { installId: first.id, enabled: true }, "admin");
    expect(service.enabled("a")[0]?.id).toBe(first.id);
    service.bind("a", first.packageKey, { installId: first.id, enabled: false }, "admin");
    expect(context.capabilities.canUse("a", first.id, "run-one")).toBe(false);
    expect(context.capabilities.snapshot("run-one")).toEqual(snapshot);
    expect(context.capabilities.db.prepare("SELECT count(*) AS count FROM capability_audit").get()).toEqual({
      count: 6
    });
  });
  it("rejects mismatched package pointers, secrets in settings, and mutable installation records", async () => {
    const { service, context, install } = await fixture();
    const first = install("v1");
    expect(() => service.bind("a", "other", { installId: first.id, enabled: true }, "admin")).toThrow("not_installed");
    expect(() =>
      service.bind(
        "a",
        first.packageKey,
        { installId: first.id, enabled: true, settings: { apiKey: "secret" } },
        "admin"
      )
    ).toThrow("references");
    expect(() =>
      context.capabilities.db
        .prepare("UPDATE capability_installs SET content_digest = ? WHERE id = ?")
        .run("changed", first.id)
    ).toThrow("immutable");
    await expect(
      service.install({ provider: "github", packageId: "owner/repo", revision: "main" }, "admin")
    ).rejects.toThrow();
    await expect(
      service.install(
        { provider: "github", packageId: "owner/repo", revision: "a".repeat(40), directory: "../escape" },
        "admin"
      )
    ).rejects.toThrow();
  });
  it("checks capability visibility and actual calls using the bound workspace rather than model arguments", async () => {
    const { service, context, install } = await fixture();
    const first = install("v1");
    service.bind("a", first.packageKey, { installId: first.id, enabled: true }, "admin");
    let calls = 0;
    const tools = new ToolRuntime(new StaticPermissionEngine({ execute: "allow" }));
    tools.register({
      name: "controlled",
      description: "controlled",
      permission: { action: "execute", resource: "test" },
      available: (scope) => context.capabilities.canUse(scope.workspaceId, first.id, scope.runId),
      async handle() {
        calls++;
        return "ok";
      }
    });
    const scope = { runId: "run", sessionId: "session", userId: "actor" };
    expect(tools.list()).toEqual([]);
    expect(tools.listForContext({ ...scope, workspaceId: "a" })).toHaveLength(1);
    expect(tools.withContext({ ...scope, workspaceId: "b" }).list()).toEqual([]);
    expect(
      (
        await tools
          .withContext({ ...scope, workspaceId: "b" })
          .call("controlled", { workspaceId: "a" }, { runId: "run", workspaceId: "a" } as { runId: string })
      ).status
    ).toBe("blocked");
    expect((await tools.call("controlled", {}, { ...scope, workspaceId: "a" })).status).toBe("succeeded");
    service.bind("a", first.packageKey, { installId: first.id, enabled: false }, "admin");
    expect((await tools.call("controlled", {}, { ...scope, workspaceId: "a" })).status).toBe("blocked");
    expect(calls).toBe(1);
  });
});
