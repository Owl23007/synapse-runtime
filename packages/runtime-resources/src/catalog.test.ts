import { describe, expect, it } from "vitest";
import { CatalogHttp, ClawHubCatalog, McpRegistryCatalog } from "./catalog.js";

describe("catalog adapters", () => {
  it("preserves author-qualified ClawHub identities and tolerates nullable catalog fields", async () => {
    const requests: string[] = [];
    const http = new CatalogHttp(async (input) => {
      const url = String(input);
      requests.push(url);
      return Response.json(
        url.includes("/search?")
          ? { results: [{ slug: "report", ownerHandle: "alice", displayName: "报告", version: null, summary: null }] }
          : url.includes("/versions?")
            ? { items: [{ version: "1.0", changelog: "first release" }] }
            : {
                skill: { slug: "report", displayName: "报告", summary: null },
                owner: { handle: "alice" },
                latestVersion: { version: "1.0" },
                moderation: { isMalwareBlocked: false, verdict: "clean" }
              }
      );
    });
    const catalog = new ClawHubCatalog(http);
    const first = await catalog.search({ query: "report" });
    expect(first.items[0]).toMatchObject({ packageId: "alice/report", author: "alice" });
    await catalog.search({ query: "report" });
    expect(requests).toHaveLength(1);
    expect(await catalog.get("alice/report")).toMatchObject({ packageId: "alice/report", version: "1.0" });
    expect((await catalog.versions("alice/report")).items).toEqual([{ version: "1.0", changelog: "first release" }]);
    expect(requests.slice(1).every((url) => new URL(url).searchParams.get("ownerHandle") === "alice")).toBe(true);
    expect(requests.some((url) => url.includes("/download"))).toBe(false);
  });
  it("honors origin-level Retry-After without immediately repeating rate-limited requests", async () => {
    let requests = 0;
    const http = new CatalogHttp(async () => {
      requests++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
    });
    await expect(http.json("https://clawhub.ai/api/v1/search?q=first")).rejects.toMatchObject({
      status: 429,
      retryAfter: 120
    });
    await expect(http.json("https://clawhub.ai/api/v1/search?q=second")).rejects.toMatchObject({ status: 429 });
    expect(requests).toBe(1);
  });
  it("filters official MCP discovery to latest versions and encodes namespace-qualified IDs", async () => {
    const requests: string[] = [];
    const server = {
      name: "io.example/report",
      version: "1.0",
      description: "reports",
      remotes: [{ type: "streamable-http", url: "https://example.org/mcp" }]
    };
    const catalog = new McpRegistryCatalog(
      new CatalogHttp(async (input) => {
        const url = String(input);
        requests.push(url);
        return Response.json(
          url.includes("/versions/") ? { server } : { servers: [{ server }], metadata: { nextCursor: "next" } }
        );
      })
    );
    expect((await catalog.search({ query: "report" })).nextCursor).toBe("next");
    expect(new URL(requests[0]!).searchParams.get("version")).toBe("latest");
    expect((await catalog.get("io.example/report", "1.0")).packageId).toBe("io.example/report");
    expect(requests[1]).toContain("io.example%2Freport");
  });
});
