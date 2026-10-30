import { afterEach, describe, expect, it } from "vitest";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { RemoteMcpConnection } from "./index.js";

const connections: RemoteMcpConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
});
function fixture(failCall = false) {
  let calls = 0;
  let enabled = true;
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method === "GET") return new Response(null, { status: 405 });
    const body = (await request.json()) as { method: string; id?: number; params?: unknown };
    requests.push(body.method);
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" }
      });
    if (body.method === "initialize")
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0" }
      });
    if (body.method === "tools/list")
      return reply({
        tools: [
          {
            name: "write",
            description: "controlled tool",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            }
          }
        ]
      });
    if (body.method === "tools/call") {
      calls++;
      if (failCall) throw new Error("lost connection with fixture-token");
      return reply({ content: [{ type: "text", text: "ok fixture-token" }] });
    }
    throw new Error("Unexpected protocol method");
  };
  const connection = new RemoteMcpConnection(
    { id: "test", url: "https://fixture.example/mcp", transport: "streamable-http", enabled: true },
    {
      timeoutMs: 500,
      token: "fixture-token",
      fetch,
      policy: { maxBytes: 10000 },
      available: (scope) => scope.workspaceId === "a" && enabled
    }
  );
  connections.push(connection);
  return {
    connection,
    requests,
    get calls() {
      return calls;
    },
    disable() {
      enabled = false;
    }
  };
}
describe("remote MCP v2 client", () => {
  it("negotiates the protocol, discovers tools, validates inputs and rechecks workspace authorization", async () => {
    const setup = fixture();
    const tools = await setup.connection.connect();
    expect(tools).toHaveLength(1);
    expect(setup.connection.status).toMatchObject({
      state: "connected",
      protocolVersion: "2025-11-25",
      serverVersion: { version: "1.0" }
    });
    const runtime = new ToolRuntime({
      async decide(request) {
        return { ...request, decision: "allow" };
      }
    });
    for (const tool of tools) runtime.register(tool);
    const scope = { sessionId: "session", runId: "run", userId: "actor", workspaceId: "a" };
    expect(runtime.list()).toEqual([]);
    expect(runtime.listForContext(scope)).toHaveLength(1);
    expect((await runtime.call(tools[0]!.name, { value: "hello" }, { ...scope, workspaceId: "b" })).status).toBe(
      "blocked"
    );
    expect(setup.calls).toBe(0);
    await expect(runtime.call(tools[0]!.name, { wrong: true }, scope)).rejects.toThrow("schema");
    expect(setup.calls).toBe(0);
    const result = await runtime.call(tools[0]!.name, { value: "hello" }, scope);
    expect(result.output).toEqual({ content: [{ type: "text", text: "ok [REDACTED]" }] });
    expect(setup.calls).toBe(1);
    setup.disable();
    expect((await runtime.call(tools[0]!.name, { value: "hello" }, scope)).status).toBe("blocked");
    expect(setup.calls).toBe(1);
  });
  it("marks a lost non-idempotent request uncertain and never retries it automatically", async () => {
    const setup = fixture(true);
    const [tool] = await setup.connection.connect();
    await expect(
      tool!.handle({ value: "hello" }, { sessionId: "session", runId: "run", userId: "actor", workspaceId: "a" })
    ).rejects.toMatchObject({ code: "outcome_uncertain" });
    expect(setup.calls).toBe(1);
    expect(setup.connection.status).toMatchObject({ state: "failed", error: "mcp_request_failed" });
    expect(JSON.stringify(setup.connection.status)).not.toContain("fixture-token");
    await setup.connection.close();
    await expect(setup.connection.connect()).rejects.toThrow("closed");
    expect(setup.calls).toBe(1);
  });
});
