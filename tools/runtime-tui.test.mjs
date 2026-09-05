import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { RuntimeAdminClient } from "../packages/runtime-client/dist/index.js";
import { LocalRuntimeProcess } from "../apps/tui/dist/local-runtime.js";
import { RuntimeConsoleController } from "../apps/tui/dist/console/controller.js";

const runtimeEntry = resolve(import.meta.dirname, "../apps/runtime/dist/cli.js");
async function fixture(t, patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), "synapse-tui-integration-"));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.ok(dir.includes("synapse-tui-integration-"));
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "runtime.json");
  await writeFile(
    configPath,
    JSON.stringify({
      runtime: { dataDir: join(dir, "data") },
      server: { host: "127.0.0.1", port: 0 },
      admin: { enabled: true, host: "127.0.0.1", port: 0 },
      channels: { qq: { adapter: "qq-official", appId: "app", appSecret: "secret", enabled: false } },
      ...patch
    })
  );
  return { dir, configPath, runtimeEntry, spawn: true };
}

test("independent TUI edits the connected server and leaves remote Runtime alive", { timeout: 30_000 }, async (t) => {
  const options = await fixture(t);
  const owned = new LocalRuntimeProcess(options);
  const connection = await owned.start(new AbortController().signal);
  const remotePath = join(options.dir, "not-a-local-config.json");
  const controller = new RuntimeConsoleController({ configPath: remotePath, ...connection });
  try {
    const client = new RuntimeAdminClient(connection);
    const unauthorized = await fetch(`${connection.endpoint}/admin/config/channels/qq`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"appId":"unauthorized"}'
    });
    assert.equal(unauthorized.status, 401);
    await controller.start();
    assert.equal(controller.snapshot.status, "running");
    assert.ok(controller.snapshot.started.port > 0);
    assert.equal(controller.snapshot.config.channels.qq.appSecret, "[REDACTED]");
    await controller.execute("/channel set qq appId updated-app");
    assert.equal(JSON.parse(await readFile(options.configPath, "utf8")).channels.qq.appId, "updated-app");
    await assert.rejects(readFile(remotePath), { code: "ENOENT" });
    await controller.execute("/channel add-qq-official extra appId=extra-app appSecret=extra-secret");
    await controller.execute("/reload");
    assert.equal(controller.snapshot.config.channels.qq.appId, "updated-app");
    assert.equal(controller.snapshot.channels.length, 2);
    const before = await readFile(options.configPath, "utf8");
    await assert.rejects(client.updateChannelConfig("qq", { enabled: "invalid" }), /HTTP 400/);
    assert.equal(await readFile(options.configPath, "utf8"), before);
    await assert.rejects(client.addChannelConfig("qq", {}), /HTTP 409/);
    await assert.rejects(client.updateChannelConfig("missing", {}), /HTTP 404/);
    await Promise.all([
      client.updateChannelConfig("qq", { appId: "parallel-app" }),
      client.updateChannelConfig("qq", { appSecret: "parallel-secret" })
    ]);
    const channel = JSON.parse(await readFile(options.configPath, "utf8")).channels.qq;
    assert.equal(channel.appId, "parallel-app");
    assert.equal(channel.appSecret, "parallel-secret");
    await controller.execute("/channel disable qq");
    assert.equal(controller.snapshot.channels.find((item) => item.id === "qq").enabled, false);
    await controller.execute("/quit");
    assert.equal(controller.snapshot.status, "stopped");
    assert.deepEqual(await client.health(), { ok: true });
  } finally {
    await controller.stop();
    await owned.stop();
  }
  await assert.rejects(fetch(`${connection.endpoint}/admin/health`));
});

test("spawned TUI uses Admin API and closes its own Runtime on exit", { timeout: 30_000 }, async (t) => {
  const controller = new RuntimeConsoleController(await fixture(t));
  try {
    await controller.start();
    assert.equal(controller.snapshot.status, "running", controller.snapshot.notices.join(" "));
    const endpoint = controller.snapshot.endpoint;
    assert.ok(endpoint.startsWith("http://127.0.0.1:"));
    await controller.execute("/channel set qq appId local-via-api");
    await controller.execute("/reload");
    assert.equal(controller.snapshot.config.channels.qq.appId, "local-via-api");
    await Promise.all([controller.stop(), controller.stop()]);
    assert.equal(controller.snapshot.status, "stopped");
    await assert.rejects(fetch(`${endpoint}/admin/health`));
  } finally {
    await controller.stop();
  }
});

test("startup failure and cancellation release owned processes", { timeout: 30_000 }, async (t) => {
  const options = await fixture(t, { admin: { enabled: false } });
  const failed = new RuntimeConsoleController(options);
  try {
    await failed.start();
    assert.equal(failed.snapshot.status, "failed");
  } finally {
    await failed.stop();
  }
  const cancelled = new RuntimeConsoleController(options);
  const starting = cancelled.start();
  await cancelled.stop();
  await starting;
  assert.equal(cancelled.snapshot.status, "stopped");
  const missing = new LocalRuntimeProcess({ ...options, runtimeEntry: join(options.dir, "missing.js") });
  await assert.rejects(missing.start(new AbortController().signal), /exited before/);
});
