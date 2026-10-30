import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "@synapse/runtime-core";
import { ArtifactStore } from "@synapse/runtime-tool-container";
import { createAdminServerFixture } from "../../../helpers/admin-server.js";
import { parseConfigObject } from "../../../../src/config/index.js";

async function createRunRoutesFixture() {
  const directory = mkdtempSync(join(tmpdir(), "synapse-run-api-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "admin-secret" }
  });
  const seed = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
  onTestFinished(() => seed.close());
  await seed.ensureSession({ sessionId: "session-a" });
  const run = seed.runs.accept({
    sessionId: "session-a",
    channelId: "channel-a",
    sourceEventId: "source-a",
    summary: "报告任务"
  });
  seed.runs.append(run.id, { key: "start", type: "run_started", status: "running" });
  seed.runs.append(run.id, { key: "context", type: "context_resolved", data: { source: "original-head" } });
  seed.runs.append(run.id, { key: "done", type: "run_succeeded", status: "succeeded" });
  const commit = seed.contextGraph.commit({
    scopeId: "session-a",
    refName: "line:main",
    expectedVersion: null,
    idempotencyKey: "root",
    type: "input",
    content: { text: "source" }
  });
  const artifacts = new ArtifactStore(join(directory, "artifacts"), config.container);
  const artifact = artifacts.save({ sessionId: "session-a", runId: run.id, callId: "call-1" }, [
    { name: "report.csv", data: Buffer.from("name,value\n报告,42") }
  ])[0]!;
  seed.close();
  const { endpoint, client } = await createAdminServerFixture(config);
  return { endpoint, client, run, commit, artifact, directory };
}

describe("运行检查 API 与持久 SSE", () => {
  it("客户端契约覆盖过滤、增量、上下文快照和会话检查", async () => {
    const { client, run, commit } = await createRunRoutesFixture();
    expect(await client.runs({ status: "succeeded" })).toMatchObject({ protocolVersion: 1, items: [{ id: run.id }] });
    expect((await client.run(run.id)).run.lastSeq).toBe(4);
    expect(await client.runEvents(run.id, 1, 2)).toMatchObject({
      events: [{ seq: 2 }, { seq: 3 }],
      hasMore: true,
      nextSeq: 3
    });
    expect(await client.runContext(run.id)).toMatchObject({ available: true, snapshot: { source: "original-head" } });
    expect((await client.sessions()).items[0]?.id).toBe("session-a");
    expect((await client.refs("session-a")).items[0]?.commitId).toBe(commit.id);
    expect(await client.commit("session-a", commit.id)).toMatchObject({ commit: { id: commit.id } });
  });

  it("新接口和流受认证保护，非法参数和未知资源有明确响应", async () => {
    const { endpoint, run } = await createRunRoutesFixture();
    for (const path of ["/admin/runs", "/admin/run-events/stream", "/admin/artifacts/none/content?sessionId=session-a"])
      expect((await fetch(endpoint + path)).status).toBe(401);
    const headers = { authorization: "Bearer admin-secret" };
    expect((await fetch(endpoint + "/admin/runs?limit=201", { headers })).status).toBe(400);
    expect((await fetch(endpoint + "/admin/runs?status=made-up", { headers })).status).toBe(400);
    expect((await fetch(endpoint + `/admin/runs/${run.id}/events?afterSeq=-1`, { headers })).status).toBe(400);
    expect((await fetch(endpoint + "/admin/runs/missing", { headers })).status).toBe(404);
    expect((await fetch(endpoint + "/admin/run-events/stream?after=999", { headers })).status).toBe(409);
    expect(
      (await fetch(endpoint + "/admin/runs", { headers: { ...headers, origin: "https://evil.invalid" } })).status
    ).toBe(403);
  });

  it("工件检查与下载校验归属，内容与摘要对应", async () => {
    const { client, artifact, endpoint } = await createRunRoutesFixture();
    expect((await client.artifacts("session-a")).items[0]?.id).toBe(artifact.id);
    expect(await client.artifact("session-a", artifact.id)).toMatchObject({ artifact: { sha256: artifact.sha256 } });
    expect(await (await client.downloadArtifact("session-a", artifact.id)).text()).toBe("name,value\n报告,42");
    expect(
      (
        await fetch(`${endpoint}/admin/artifacts/${artifact.id}/content?sessionId=other`, {
          headers: { authorization: "Bearer admin-secret" }
        })
      ).status
    ).toBe(404);
  });

  it("SSE 从持久游标补读，握手后新增事件也不会丢失", async () => {
    const { endpoint, directory, run } = await createRunRoutesFixture();
    const abort = new AbortController();
    const response = await fetch(endpoint + "/admin/run-events/stream", {
      headers: { authorization: "Bearer admin-secret", "last-event-id": "2" },
      signal: abort.signal
    });
    const reader = response.body!.getReader();
    const other = new SqliteRuntimeContextStore({ databasePath: join(directory, "runtime-context.sqlite") });
    onTestFinished(() => other.close());
    try {
      const next = other.runs.accept({
        sessionId: "session-a",
        channelId: "channel-a",
        sourceEventId: "source-b",
        summary: "新请求"
      });
      const text = await readUntil(reader, (value) => value.includes(next.id));
      expect(text).toContain("event: snapshot");
      expect(text).toContain(`"runId":"${run.id}","seq":3`);
      expect(text).toContain("id: 5");
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      other.close();
    }
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const timeout = setTimeout(() => {
    void reader.cancel();
  }, 4_000);
  try {
    while (!done(text)) {
      const result = await reader.read();
      if (result.done) throw new Error("SSE ended before expected events");
      text += decoder.decode(result.value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
