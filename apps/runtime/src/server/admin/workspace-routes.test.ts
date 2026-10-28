import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { RuntimeServer } from "../runtime-server.js";
import { parseConfigObject } from "../../config/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "synapse-native-"));
  const config = parseConfigObject({
    runtime: { dataDir: directory },
    server: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: "workspace-token" }
  });
  let server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  const connect = async () => {
    const listening = await server.start();
    const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
    return { client: new RuntimeAdminClient({ endpoint, token: "workspace-token" }), endpoint };
  };
  const connection = await connect();
  cleanup.push(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...connection,
    restart: async () => {
      await server.stop();
      server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
      return connect();
    }
  };
}

async function execute(client: RuntimeAdminClient, sessionId: string, lineId: string, text: string, key: string) {
  const result = await client.submitRun({ sessionId, lineId, text, idempotencyKey: key });
  await expect.poll(async () => (await client.run(result.run.id)).run.status).toBe("succeeded");
  return result.run.id;
}

describe("第一方会话工作台", () => {
  it("无需频道完成多轮运行，幂等提交不重复，重启后消息和图保持可用", async () => {
    const setup = await fixture();
    const { client } = setup;
    const { session } = await client.createSession("原生工作区", "create-a");
    expect((await client.createSession("原生工作区", "create-a")).session.id).toBe(session.id);
    expect((await client.sessions()).items[0]?.title).toBe("原生工作区");
    await expect(client.createSession("不同标题", "create-a")).rejects.toThrow("409");
    const first = await execute(client, session.id, session.mainlineId, "第一轮", "first");
    expect(
      (
        await client.submitRun({
          sessionId: session.id,
          lineId: session.mainlineId,
          text: "第一轮",
          idempotencyKey: "first"
        })
      ).run.id
    ).toBe(first);
    await expect(
      client.submitRun({ sessionId: session.id, lineId: session.mainlineId, text: "不同输入", idempotencyKey: "first" })
    ).rejects.toThrow("409");
    await execute(client, session.id, session.mainlineId, "第二轮", "second");
    expect((await client.workspace(session.id)).messages.map((item) => item.payload.text)).toEqual([
      "第一轮",
      "第一轮",
      "第二轮",
      "第二轮"
    ]);
    const graph = await client.sessionGraph(session.id);
    expect(graph.nodes.filter((node) => node.type === "input")).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.type === "session")).toHaveLength(1);
    expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source))).toBe(true);
    const restarted = await setup.restart();
    expect((await restarted.client.workspace(session.id)).messages).toHaveLength(4);
    expect((await restarted.client.sessionGraph(session.id)).nodes).toEqual(graph.nodes);
    expect((await restarted.client.runs({ sessionId: session.id })).items).toHaveLength(2);
  });

  it("历史分叉保持图连续，分支执行隔离，合并拒绝过期主线版本和来源头", async () => {
    const { client } = await fixture();
    const { session } = await client.createSession("历史探索", "history");
    await execute(client, session.id, session.mainlineId, "原方案", "main");
    const original = await client.sessionGraph(session.id);
    const originalHead = original.refs.find((ref) => ref.name === `line:${session.mainlineId}`)!;
    const historical = original.nodes.find((node) => node.type === "input")!;
    const { branch } = await client.forkSession(session.id, {
      commitId: historical.id,
      title: "备选方案",
      idempotencyKey: "fork-a"
    });
    expect(
      (await client.forkSession(session.id, { commitId: historical.id, title: "备选方案", idempotencyKey: "fork-a" }))
        .branch.id
    ).toBe(branch.id);
    await execute(client, session.id, branch.id, "新方案", "branch-run");
    expect(
      (await client.forkSession(session.id, { commitId: historical.id, title: "备选方案", idempotencyKey: "fork-a" }))
        .branch.id
    ).toBe(branch.id);
    const afterBranch = await client.sessionGraph(session.id);
    expect(afterBranch.refs.find((ref) => ref.name === originalHead.name)).toEqual(originalHead);
    const branchHead = afterBranch.refs.find((ref) => ref.name === `line:${branch.id}`)!;
    const branchInput = afterBranch.nodes.find((node) => node.content.input === "新方案")!;
    expect(branchInput.parents).toContain(historical.id);
    expect((await client.workspace(session.id, branch.id)).messages.map((item) => item.payload.text)).toEqual([
      "新方案",
      "新方案"
    ]);
    const merge = {
      branchId: branch.id,
      expectedVersion: originalHead.version,
      sourceCommitId: branchHead.commitId,
      idempotencyKey: "merge-a"
    };
    await expect(client.mergeSession(session.id, { ...merge, expectedVersion: 0 })).rejects.toThrow("409");
    await expect(client.mergeSession(session.id, { ...merge, sourceCommitId: historical.id })).rejects.toThrow("409");
    await client.mergeSession(session.id, merge);
    await client.mergeSession(session.id, merge);
    const afterMerge = await client.sessionGraph(session.id);
    const main = afterMerge.refs.find((ref) => ref.name === originalHead.name)!;
    const merged = afterMerge.nodes.find((node) => node.id === main.commitId)!;
    expect(merged.parents).toEqual([originalHead.commitId, branchHead.commitId]);
    expect(merged.content.summary).toBe("新方案");
    expect((await client.workspace(session.id)).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "branch_result", payload: expect.objectContaining({ summary: "新方案" }) })
      ])
    );
    expect(afterMerge.nodes.filter((node) => node.content.branchId === branch.id)).toHaveLength(1);
    for (const commit of original.nodes) expect(afterMerge.nodes.find((node) => node.id === commit.id)).toEqual(commit);
  });

  it("写入受认证保护，会话线与提交隔离，有界图保留回溯边界", async () => {
    const { client, endpoint } = await fixture();
    expect(
      (
        await fetch(`${endpoint}/admin/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      ).status
    ).toBe(401);
    const a = (await client.createSession("A", "a")).session;
    const b = (await client.createSession("B", "b")).session;
    await execute(client, a.id, a.mainlineId, "输入", "input");
    await expect(client.workspace(a.id, b.mainlineId)).rejects.toThrow("404");
    await expect(
      client.submitRun({ sessionId: a.id, lineId: b.mainlineId, text: "不允许", idempotencyKey: "foreign" })
    ).rejects.toThrow("409");
    const graphA = await client.sessionGraph(a.id);
    await expect(client.sessionGraph(b.id, graphA.nodes[0]!.id)).rejects.toThrow("404");
    await expect(
      client.forkSession(b.id, { commitId: graphA.nodes[0]!.id, title: "越界", idempotencyKey: "foreign" })
    ).rejects.toThrow("404");
    const bounded = await fetch(`${endpoint}/admin/sessions/${a.id}/graph?limit=1`, {
      headers: { authorization: "Bearer workspace-token" }
    });
    expect(await bounded.json()).toMatchObject({
      truncated: true,
      nodes: [expect.anything()],
      boundary: expect.arrayContaining([expect.any(String)])
    });
    const runCount = (await client.runs()).items.length;
    await client.sessionGraph(a.id, graphA.nodes[0]!.id);
    expect((await client.runs()).items).toHaveLength(runCount);
  });
});
