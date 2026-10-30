import { onTestFinished, describe, expect, it } from "vitest";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { RemoteMcpConnection } from "../../src/index.js";

function createMcpFixture(failCall = false) {
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
  onTestFinished(() => connection.close());
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
describe("远程 MCP 第二版客户端", () => {
  it("协商协议、发现工具、校验输入并复查工作区授权", async () => {
    const testContext = createMcpFixture();
    const tools = await testContext.connection.connect();
    expect(tools).toHaveLength(1);
    expect(testContext.connection.status).toMatchObject({
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
    expect(testContext.calls).toBe(0);
    await expect(runtime.call(tools[0]!.name, { wrong: true }, scope)).rejects.toThrow("schema");
    expect(testContext.calls).toBe(0);
    const result = await runtime.call(tools[0]!.name, { value: "hello" }, scope);
    expect(result.output).toEqual({ content: [{ type: "text", text: "ok [REDACTED]" }] });
    expect(testContext.calls).toBe(1);
    testContext.disable();
    expect((await runtime.call(tools[0]!.name, { value: "hello" }, scope)).status).toBe("blocked");
    expect(testContext.calls).toBe(1);
  });
  it("将丢失的非幂等请求标记为不确定且不自动重试", async () => {
    const testContext = createMcpFixture(true);
    const [tool] = await testContext.connection.connect();
    await expect(
      tool!.handle({ value: "hello" }, { sessionId: "session", runId: "run", userId: "actor", workspaceId: "a" })
    ).rejects.toMatchObject({ code: "outcome_uncertain" });
    expect(testContext.calls).toBe(1);
    expect(testContext.connection.status).toMatchObject({ state: "failed", error: "mcp_request_failed" });
    expect(JSON.stringify(testContext.connection.status)).not.toContain("fixture-token");
    await testContext.connection.close();
    await expect(testContext.connection.connect()).rejects.toThrow("closed");
    expect(testContext.calls).toBe(1);
  });
});
