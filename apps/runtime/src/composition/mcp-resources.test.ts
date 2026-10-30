import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { ToolRuntime } from "@synapse/runtime-tool-runtime";
import { StaticPermissionEngine } from "@synapse/runtime-permission";
import { CapabilityResources } from "./capability-resources.js";
import { parseConfigObject } from "../config/index.js";

describe("MCP production composition", () => {
  it("replaces handlers after a failed connection and keeps the logical permission stable", async () => {
    let calls = 0;
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      let bytes = "";
      request.on("data", (chunk) => {
        bytes += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(bytes) as { id?: number; method: string };
        if (body.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply = (result: unknown) =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        if (body.method === "initialize") {
          reply({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" }
          });
          return;
        }
        if (body.method === "tools/list") {
          reply({ tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] });
          return;
        }
        if (body.method === "tools/call") {
          calls++;
          if (calls === 1) response.writeHead(500).end("lost result");
          else reply({ content: [{ type: "text", text: "reconnected" }] });
          return;
        }
        response.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const root = mkdtempSync(join(tmpdir(), "synapse-mcp-composition-"));
    const context = new SqliteRuntimeContextStore({ databasePath: join(root, "runtime.sqlite") });
    const tools = new ToolRuntime(new StaticPermissionEngine({ "mcp.example.call": "allow", "skill.read": "allow" }));
    const config = parseConfigObject({
      runtime: { dataDir: root },
      capabilities: { skillsDirectory: join(root, "skills"), autoCheckUpdates: false },
      mcp: {
        allowedHosts: ["127.0.0.1"],
        privateHosts: ["127.0.0.1"],
        timeoutMs: 1000,
        servers: [
          {
            id: "example",
            transport: "streamable-http",
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
          }
        ]
      }
    });
    const resources = new CapabilityResources(config, context, tools);
    try {
      await context.resolveWorkspace({
        platform: "native",
        provider: "native",
        channelId: "native",
        conversationType: "private",
        conversationId: "session",
        identityId: "actor",
        defaultWorkspace: { id: "a", type: "personal", name: "a" }
      });
      const install = context.capabilities.list("mcp")[0]!;
      resources.service.bind("a", install.packageKey, { installId: install.id, enabled: true }, "admin");
      const first = await resources.connect(install.id);
      expect(first.permissionAction).toBe("mcp.example.call");
      const scope = { sessionId: "session", userId: "actor", runId: "run-one", workspaceId: "a" };
      const name = tools.listForContext(scope).find((tool) => tool.name.startsWith("mcp:"))!.name;
      await expect(tools.call(name, {}, scope)).rejects.toMatchObject({ code: "outcome_uncertain" });
      expect(calls).toBe(1);
      await resources.connect(install.id);
      expect((await tools.call(name, {}, { ...scope, runId: "run-two" })).output).toEqual({
        content: [{ type: "text", text: "reconnected" }]
      });
      expect(calls).toBe(2);
      resources.service.bind("a", install.packageKey, { installId: install.id, enabled: false }, "admin");
      expect((await tools.call(name, {}, scope)).status).toBe("blocked");
    } finally {
      await resources.close();
      context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
