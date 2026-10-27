/* oxlint-disable no-await-in-loop -- 逐项采集真实命令输出，TUI 视图与生命周期检查必须按顺序执行 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { LocalRuntimeProcess } from "../../apps/tui/dist/local-runtime.js";
import { RuntimeConsoleController } from "../../apps/tui/dist/console/controller.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const dir = await mkdtemp(join(tmpdir(), "synapse-channel-probe-"));
const runtimeEntry = resolve(root, "apps/runtime/dist/cli.js");
const configPath = join(dir, "runtime.json");
const runId = randomUUID();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const owned = new LocalRuntimeProcess({ configPath, runtimeEntry, spawn: true });
let controller;
let connection;

async function record(name, direction, input, output, conclusion, limitations = [], status = "tested-supported") {
  const fixture = {
    schemaVersion: "channel-protocol-fixture/v1",
    id: `cli.${direction}.${name}.live.v1`,
    channel: "cli",
    direction,
    capability: name,
    status,
    capturedAt: new Date().toISOString(),
    provenance: {
      kind: "local-terminal-capture",
      source: "README.md; apps/runtime/src/cli.ts --help; tools/channel-fixtures/probe-cli.mjs",
      testRunId: runId
    },
    environment: {
      provider: "runtime-cli-tui",
      adapterVersion: "0.1.0",
      nodeVersion: process.version,
      runtimeCommit: commit,
      transport: "child-process/admin-http"
    },
    redactions: ["测试使用独立临时配置、随机管理令牌和临时端口", "端点、时间戳、路径和令牌替换为占位符"],
    artifacts: { terminalInput: input, terminalOutput: output },
    conclusion,
    limitations
  };
  const path = resolve(root, "fixtures/cli", direction);
  await mkdir(path, { recursive: true });
  let content = JSON.stringify(fixture, null, 2);
  for (const [from, to] of [
    [connection?.token, "[REDACTED]"],
    [connection?.endpoint, "<admin-endpoint>"],
    [dir, "<test-directory>"]
  ]) {
    if (from) content = content.replaceAll(from, to).replaceAll(JSON.stringify(from).slice(1, -1), to);
  }
  content = content.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (value) =>
    value === fixture.capturedAt ? value : "<timestamp>"
  );
  await writeFile(join(path, `${name}.live.fixture.json`), content + "\n");
  console.log(`${fixture.status}: ${name}`);
}

async function cli(args, token = connection.token) {
  try {
    const result = await execute(
      process.execPath,
      [runtimeEntry, ...args, "--endpoint", connection.endpoint, "--profile-config", join(dir, "profiles.json")],
      {
        env: { ...process.env, SYNAPSE_RUNTIME_TOKEN: token },
        cwd: dir,
        windowsHide: true,
        timeout: 15_000
      }
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

try {
  await writeFile(
    configPath,
    JSON.stringify({
      runtime: { dataDir: join(dir, "data") },
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0 },
      agent: { default: "echo", providers: { echo: { type: "echo" } } }
    })
  );
  connection = await owned.start(new AbortController().signal);
  for (const command of ["status", "channels"]) {
    const result = await cli([command]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    if (command === "channels") assert.deepEqual(body.channels, []);
    await record(
      command,
      "outbound",
      { executable: "synapse-runtime", args: [command, "--endpoint", "<admin-endpoint>"] },
      { ...result, stdout: body },
      "CLI 通过真实 Admin API 输出单个 JSON 文档，成功退出码为 0；管理命令不等于聊天输入输出"
    );
  }
  const unauthorized = await cli(["status"], "fixture-invalid-token");
  assert.equal(unauthorized.exitCode, 1);
  assert.equal(unauthorized.stdout, "");
  assert.match(unauthorized.stderr, /401/);
  await record(
    "unauthorized",
    "errors",
    { executable: "synapse-runtime", args: ["status"], authentication: "invalid-test-credential" },
    unauthorized,
    "鉴权失败写入 stderr，退出码为 1；stdout 保持为空，不能将错误当作成功 JSON 消息"
  );
  const unknown = await cli(["chat", "fixture text"]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /runtime\.config\.toml/);
  await record(
    "unknown-command",
    "errors",
    { executable: "synapse-runtime", args: ["chat", "fixture text"] },
    unknown,
    "文档未声明 chat 命令；实测未知位置参数回落到默认 start 并尝试读配置，没有输出明确的未知命令错误",
    ["在无默认配置的临时目录运行以避免意外启动服务；不能将此错误当作规范化的 unsupported"],
    "tested-partial"
  );
  const invalid = await cli(["--fixture-unknown-argument"]);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /Unknown argument/);
  await record(
    "unknown-argument",
    "errors",
    { executable: "synapse-runtime", args: ["--fixture-unknown-argument"] },
    invalid,
    "未知选项有明确错误，但未知位置参数与它的行为不同，channel 需定义一致的命令拒绝语义"
  );
  controller = new RuntimeConsoleController({ configPath, ...connection, profilePath: join(dir, "profiles.json") });
  await controller.start();
  assert.equal(controller.snapshot.status, "running");
  for (const [command, view] of [
    ["/status", "overview"],
    ["/channels", "channels"],
    ["/config", "config"]
  ]) {
    assert.equal(await controller.execute(command), "continue");
    assert.equal(controller.snapshot.view, view);
    await record(
      `tui-${command.slice(1)}`,
      "inbound",
      command,
      {
        result: "continue",
        status: controller.snapshot.status,
        view: controller.snapshot.view,
        notices: controller.snapshot.notices
      },
      "TUI 控制器连接真实服务解释管理命令；命令改变本地视图但不构成 SynapseChannelEvent",
      ["未通过伪终端验证 Ink 渲染、键盘与终端宽度"]
    );
  }
  await controller.execute("fixture text");
  assert.match(controller.snapshot.notices.join(" "), /Unknown command/);
  await record(
    "tui-plain-text",
    "errors",
    "fixture text",
    { notices: controller.snapshot.notices },
    "普通文本被作为未知管理命令反馈，当前 TUI 没有将它提交为聊天消息"
  );
  assert.equal(await controller.execute("/quit"), "exit");
  assert.equal(controller.snapshot.status, "stopped");
  const health = await fetch(`${connection.endpoint}/admin/health`, {
    headers: { authorization: `Bearer ${connection.token}` }
  });
  assert.equal(health.status, 200);
  await record(
    "tui-attached-quit",
    "outbound",
    "/quit",
    { result: "exit", status: controller.snapshot.status, runtimeHealthHttpStatus: health.status },
    "附着模式退出 TUI 后，独立 Runtime 仍然存活；channel 断开和服务停机必须有不同语义"
  );
} finally {
  await controller?.stop();
  await owned.stop();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && dir.includes("synapse-channel-probe-"));
  await rm(dir, { recursive: true, force: true });
}
