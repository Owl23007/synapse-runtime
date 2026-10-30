import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, expect, it } from "vitest";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { RuntimeServer } from "../../../../src/server/runtime-server.js";
import { parseConfigObject } from "../../../../src/config/index.js";

it("长会话逐条脱敏，超大或缺失载荷不破坏消息身份和跨页游标", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synapse-workspace-history-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const token = "history-deployment-secret";
  const store = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
  onTestFinished(() => store.close());
  const session = await store.ensureSession({ sessionId: "history" });
  for (let index = 1; index <= 110; index++)
    await store.appendEvent(session.mainlineId, {
      id: `history-${index}`,
      type: "user_message",
      idempotencyKey: `history-${index}`,
      ...(index === 110
        ? {}
        : { payload: { text: index === 109 ? "中\u0000".repeat(12_000) : `${index}:${"x".repeat(1600)} ${token}` } })
    });
  store.close();
  const server = new RuntimeServer({
    config: parseConfigObject({
      runtime: { dataDir: directory },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, token }
    }),
    logger: { info() {}, warn() {}, error() {} }
  });
  try {
    const listening = await server.start();
    const client = new RuntimeAdminClient({ endpoint: `http://127.0.0.1:${listening.admin!.port}`, token });
    const recent = await client.workspace(session.id);
    expect(recent.messages).toHaveLength(100);
    expect(recent.hasMore).toBe(true);
    expect(recent.nextCursor).toBe(11);
    expect(recent.session.id).toBe(session.id);
    expect(recent.line.id).toBe(session.mainlineId);
    for (const [index, message] of recent.messages.entries()) {
      expect(message.id).toBe(`history-${index + 11}`);
      expect(message.sequence).toBe(index + 11);
      expect(message.payload).toEqual(expect.any(Object));
    }
    expect(recent.messages.at(-2)?.payload.text).toContain("[TRUNCATED]");
    expect(recent.messages.at(-1)?.payload).toEqual({});
    expect(JSON.stringify(recent)).not.toContain(token);
    expect(recent.messages[0]?.payload.text).toContain("[REDACTED]");
    const earlier = await client.workspace(session.id, undefined, recent.nextCursor);
    expect(earlier.messages).toHaveLength(10);
    expect(earlier.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `history-${index + 1}`)
    );
    expect(earlier.hasMore).toBe(false);
    expect(earlier.nextCursor).toBe(1);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
