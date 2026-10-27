/* oxlint-disable no-await-in-loop -- 请求、引用、撤回与文件操作依赖平台时序，串行执行避免重复交付和速率干扰 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";

// 可通过 SSH 的标准输入运行，依赖从目标部署解析，令牌始终留在目标机器内存中
const root = process.cwd();
const require = createRequire(resolve(root, "packages/channel-onebot11/package.json"));
const WebSocket = require("ws");
const env = { ...parseEnv(await readFile(resolve(root, ".env"), "utf8").catch(() => "")), ...process.env };
const config = env.NAPCAT_CONFIG ? JSON.parse(await readFile(env.NAPCAT_CONFIG, "utf8")) : undefined;
const server = config?.network?.websocketServers?.find((item) => item.enable);
const endpoint = env.NAPCAT_WS_URL ?? (server ? `ws://127.0.0.1:${server.port}` : "ws://127.0.0.1:3001");
const token = env.NAPCAT_TOKEN ?? server?.token;
const privateId = env.FIXTURE_PRIVATE_ID;
const groupId = env.FIXTURE_GROUP_ID;
assert.ok(privateId && groupId, "Set FIXTURE_PRIVATE_ID and FIXTURE_GROUP_ID to authorized test targets");
assert.match(privateId, /^\d+$/);
assert.match(groupId, /^\d+$/);
assert.ok(
  [undefined, "send", "listen", "history", "cleanup", "cleanup-files", "image"].includes(env.FIXTURE_MODE),
  "Unknown FIXTURE_MODE"
);
if (env.FIXTURE_LISTEN_MS)
  assert.ok(Number.isFinite(Number(env.FIXTURE_LISTEN_MS)) && Number(env.FIXTURE_LISTEN_MS) > 0);
if (env.FIXTURE_MODE === "cleanup-files")
  assert.ok(Number.isFinite(Number(env.FIXTURE_AFTER)), "cleanup-files requires FIXTURE_AFTER");
const runId = randomUUID();
const marker = env.FIXTURE_MARKER ?? `synapse-protocol-${runId}`;
const pending = new Map();
const events = [];
const sentIds = [];
const aliases = new Map([
  [privateId, "<user-1>"],
  [groupId, "<group-1>"]
]);
let sequence = 0;
let version = "unknown";
let failed = false;
const socket = new WebSocket(endpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
socket.on("error", () => {});
socket.on("message", (frame) => {
  let body;
  try {
    body = JSON.parse(frame.toString());
  } catch {
    return;
  }
  if (body.post_type) {
    // 不保留任何无测试标记的真实用户消息
    if ((JSON.stringify(body.message) ?? "").includes(marker) || String(body.raw_message ?? "").includes(marker))
      events.push(body);
    return;
  }
  const entry = pending.get(body.echo);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(body.echo);
    entry.resolve(body);
  }
});

function call(action, params = {}) {
  const request = { action, params, echo: `fixture:${++sequence}` };
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.echo);
      reject(new Error("response-timeout"));
    }, 15_000);
    pending.set(request.echo, {
      resolve: (response) => {
        if (action === "send_msg" && response.data?.message_id !== undefined) sentIds.push(response.data.message_id);
        resolveCall({ request, response });
      },
      timer
    });
    socket.send(JSON.stringify(request), (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(request.echo);
      reject(new Error("send-failed"));
    });
  });
}

function alias(value, kind) {
  const key = String(value);
  if (!aliases.has(key)) aliases.set(key, `<${kind}-${aliases.size + 1}>`);
  return aliases.get(key);
}

function redact(value, key = "") {
  if (value === null || value === undefined) return value;
  if (/token|secret|password|authorization|cookie|signature/i.test(key)) return "[REDACTED]";
  if (
    /^(?:user_id|self_id|group_id|message_id|real_id|message_seq|real_seq|target_id|sender_id|peer_id|file_id|file_unique|uuid|msgId|uid|uin|senderUid|peerUid)$/.test(
      key
    )
  ) {
    return alias(
      value,
      key.includes("message") || key === "real_id" ? "message" : key.includes("file") ? "file" : "account"
    );
  }
  if (/^(?:nickname|card|title|avatar|avatar_url|url|path|file_name|group_name)$/.test(key)) return `<${key}>`;
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === "string") {
    if (key === "echo") return "<request-1>";
    if (key === "qq") return alias(value, "user");
    if (key === "id") return alias(value, "id");
    if (key === "file") return value.startsWith("base64://") ? "base64://[REDACTED]" : "<file-resource>";
    if (key === "message" || key === "wording")
      return value === "" ? "" : value.includes(marker) ? replaceKnown(value) : "[REDACTED]";
    return replaceKnown(value);
  }
  return value;
}

function replaceKnown(value) {
  let result = value.replaceAll(marker, "fixture protocol text");
  for (const [original, replacement] of aliases) result = result.replaceAll(original, replacement);
  if (token) result = result.replaceAll(token, "[REDACTED]");
  // 文件和图片响应可能附带签名下载地址，不能持久化到证据中
  return result
    .replace(/https?:\/\/[^\s\]"<>]+/g, "https://example.test/redacted")
    .replace(/base64:\/\/[A-Za-z0-9+/=]+/g, "base64://[REDACTED]");
}

async function record(name, direction, artifacts, supported, conclusion, limitations = []) {
  const fixture = {
    schemaVersion: "channel-protocol-fixture/v1",
    id: `onebot11.${direction}.${name}.live.v1`,
    channel: "onebot11",
    direction,
    capability: name,
    status: supported ? "tested-supported" : "tested-partial",
    capturedAt: new Date().toISOString(),
    provenance: { kind: "real-api-capture", source: "tools/channel-fixtures/probe-napcat.mjs", testRunId: runId },
    environment: {
      provider: "napcat",
      adapterVersion: version,
      transport: "websocket",
      nodeVersion: process.version,
      runtimeCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      documentation: `https://napneko.github.io/api/${version}`,
      messagePostFormat: server?.messagePostFormat ?? "unknown"
    },
    redactions: [
      "账号、群、消息、文件标识使用稳定占位符",
      "昵称、路径、签名 URL、令牌和文件内容已脱敏",
      "仅记录带本轮测试标记的消息"
    ],
    artifacts: redact(artifacts),
    conclusion,
    limitations
  };
  if (!supported) failed = true;
  if (process.argv.includes("--stdout") || env.FIXTURE_STDOUT === "1") console.log(JSON.stringify(fixture));
  else {
    const dir = resolve(root, "fixtures/onebot11", direction);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `${name}.live.fixture.json`), JSON.stringify(fixture, null, 2) + "\n");
    console.log(`${fixture.status}: ${name}`);
  }
}

async function probe(name, action, params, check, conclusion, limitations = []) {
  try {
    const { request, response } = await call(action, params);
    const supported = check(response);
    await record(
      name,
      response.status === "failed" ? "errors" : "outbound",
      { platformRequest: request, platformResponse: response },
      supported,
      conclusion,
      limitations
    );
    return response;
  } catch {
    failed = true;
    console.error(`Probe failed: ${name} (transport error; no platform conclusion)`);
    return undefined;
  }
}

const ok = (r) => r.status === "ok" && r.retcode === 0;
try {
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("connection-timeout"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolveOpen();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("connection-failed"));
    });
  });
  const info = await call("get_version_info");
  version = String(info.response.data?.app_version ?? "unknown");
  await record(
    "get-version-info",
    "outbound",
    { platformRequest: info.request, platformResponse: info.response },
    ok(info.response),
    "以部署返回的版本定位实测范围，不能用文档最新版本代替部署版本"
  );
  const identity = await call("get_login_info");
  const selfId = identity.response.data?.user_id;
  assert.ok(selfId !== undefined && ok(identity.response), "Cannot establish bot identity");
  alias(selfId, "bot");
  if (env.FIXTURE_MODE === "cleanup") {
    for (const [kind, id] of [
      ["private", privateId],
      ["group", groupId]
    ]) {
      const history = await call(kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
        ...(kind === "group" ? { group_id: id } : { user_id: id }),
        count: 30
      });
      const messages = history.response.data?.messages ?? [];
      for (const message of messages) {
        const text = JSON.stringify(message.message);
        if (
          String(message.user_id ?? message.sender?.user_id) === String(selfId) &&
          text?.includes("synapse-protocol-")
        ) {
          await probe(
            `recall-${kind}-${sentIds.length + 1}`,
            "delete_msg",
            { message_id: message.message_id },
            ok,
            "仅撤回历史中含专用测试标记的消息，平台成功回执与客户端消失需分别确认"
          );
          sentIds.push(message.message_id);
        }
      }
    }
  }
  if (env.FIXTURE_MODE === "cleanup-files") {
    const listed = await call("get_group_root_files", { group_id: groupId });
    console.error(`Group file listing status: ${listed.response.status}; retcode: ${listed.response.retcode}`);
    for (const file of listed.response.data?.files ?? []) {
      if (file.file_name === "synapse-protocol-fixture.txt")
        console.error(`Test file upload_time: ${Number(file.upload_time)}; busid: ${Number(file.busid)}`);
      if (
        file.file_name === "synapse-protocol-fixture.txt" &&
        String(file.uploader) === String(selfId) &&
        file.upload_time >= Number(env.FIXTURE_AFTER)
      ) {
        await probe(
          "delete-group-test-file",
          "delete_group_file",
          { group_id: groupId, file_id: file.file_id, busid: file.busid },
          ok,
          "群文件需要独立删除动作，不能假设 delete_msg 撤回通知会删除群文件"
        );
      }
    }
  }
  if (env.FIXTURE_MODE === "history") {
    for (const [kind, id] of [
      ["private", privateId],
      ["group", groupId]
    ]) {
      const history = await call(kind === "group" ? "get_group_msg_history" : "get_friend_msg_history", {
        ...(kind === "group" ? { group_id: id } : { user_id: id }),
        count: 30
      });
      const matched = (history.response.data?.messages ?? []).filter((message) =>
        JSON.stringify(message.message)?.includes(marker)
      );
      console.error(`${kind}: ${matched.length} marked history message(s)`);
      for (const [index, message] of matched.entries()) {
        await record(
          `history-${kind}-input-${index + 1}`,
          "inbound",
          { platformEvent: message },
          true,
          "测试账号输入由真实历史查询返回，可用于验证消息字段和归一化；不能作为 WebSocket 推送到达的证据",
          ["来源为历史查询中的消息快照；推送时序、重连和丢失恢复尚未验证"]
        );
      }
    }
  }
  if (!env.FIXTURE_MODE || env.FIXTURE_MODE === "send") {
    await probe(
      "get-status",
      "get_status",
      {},
      (r) => ok(r) && typeof r.data?.online === "boolean",
      "文档预期 online/good 为运行状态；WebSocket 建连本身不能证明 QQ 在线"
    );
    const login = await call("get_login_info");
    if (login.response.data?.user_id) alias(login.response.data.user_id, "bot");
    await record(
      "get-login-info",
      "outbound",
      { platformRequest: login.request, platformResponse: login.response },
      ok(login.response),
      "登录身份查询独立于连接状态"
    );
    await probe(
      "unknown-action",
      "synapse_fixture_unknown_action",
      {},
      (r) => r.status === "failed" && r.retcode !== 0,
      "未知动作应返回可关联的显式失败，不能被归一化为成功"
    );
    for (const [kind, id] of [
      ["private", privateId],
      ["group", groupId]
    ]) {
      const target = kind === "group" ? { group_id: id } : { user_id: id };
      const sent = await probe(
        `send-${kind}-text`,
        "send_msg",
        { ...target, message_type: kind, message: `${marker} ${kind} 中文 & [text]`, auto_escape: false },
        (r) => ok(r) && r.data?.message_id !== undefined,
        "验证适配器实际使用的 send_msg、字符串 CQ 编码和数字字符串目标标识；成功回执仅证明平台接受",
        ["接收端渲染与用户阅读需要人工确认"]
      );
      if (sent?.data?.message_id !== undefined) {
        alias(sent.data.message_id, "message");
        await probe(
          `get-${kind}-message`,
          "get_msg",
          { message_id: sent.data.message_id },
          (r) => ok(r) && JSON.stringify(r.data?.message).includes(marker),
          "发送回执的消息标识应可用于查询，查询内容需含本轮专用测试标记"
        );
        await probe(
          `send-${kind}-reply`,
          "send_msg",
          {
            ...target,
            message_type: kind,
            message: `[CQ:reply,id=${sent.data.message_id}]${marker} reply`,
            auto_escape: false
          },
          (r) => ok(r) && r.data?.message_id !== undefined,
          "引用片段使用已有消息标识编码为 CQ reply",
          ["引用是否在客户端可见需要人工确认"]
        );
      }
      const file = `base64://${Buffer.from(`${marker}\nfixture file 中文\n`).toString("base64")}`;
      await probe(
        `upload-${kind}-file`,
        `upload_${kind}_file`,
        { ...target, file, name: "synapse-protocol-fixture.txt", upload_file: true },
        ok,
        "验证远端 NapCat 支持 base64 内容上传及 upload_file 参数；上传成功不保证响应包含 file_id",
        ["仅测试小型 UTF-8 文本文件，不代表文件大小上限或所有类型均可用"]
      );
    }
    await probe(
      "send-group-mention",
      "send_msg",
      {
        group_id: groupId,
        message_type: "group",
        message: `[CQ:at,qq=${privateId}] ${marker} mention`,
        auto_escape: false
      },
      (r) => ok(r) && r.data?.message_id !== undefined,
      "验证 CQ at 与文本混合发送；不将发送成功等同于客户端通知成功",
      ["被 @ 的账号可能不在测试群；通知与显示需要人工确认"]
    );
  }
  if (!env.FIXTURE_MODE || env.FIXTURE_MODE === "send" || env.FIXTURE_MODE === "image") {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNwaDhAEmIY1TCqYfhqAACldYAQpGTU2QAAAABJRU5ErkJggg==";
    await probe(
      "send-group-image",
      "send_msg",
      {
        group_id: groupId,
        message_type: "group",
        message: `${marker} image[CQ:image,file=base64://${png}]`,
        auto_escape: false
      },
      (r) => ok(r) && r.data?.message_id !== undefined,
      "验证 base64 图片与文本的混合 CQ 消息",
      ["仅验证单张 16×16 PNG，客户端显示需要人工确认"]
    );
    // 发送后逐条撤回，超时仍属于结果未知，不能自动重发消息
    for (const [index, messageId] of sentIds.entries()) {
      await probe(
        `recall-message-${index + 1}`,
        "delete_msg",
        { message_id: messageId },
        ok,
        "使用真实发送回执中的消息标识撤回本轮测试消息"
      );
    }
  }
  if (env.FIXTURE_LISTEN_MS) {
    console.error("Waiting for marked inbound test messages");
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(Number(env.FIXTURE_LISTEN_MS), 60_000)));
  }
  for (const [index, event] of events.entries()) {
    await record(
      `message-event-${index + 1}`,
      "inbound",
      { platformEvent: event },
      true,
      "真实上报包含专用测试标记；须区分 message 与 message_sent，不能自动将机器人发送事件当作用户输入",
      ["本轮自动发送产生的事件不等于用户主动发送；真实入站需要测试账号回复专用标记"]
    );
  }
  if (events.length === 0) console.error("No marked inbound events observed; inbound support remains unverified");
} catch {
  failed = true;
  console.error("NapCat connection failed; no capability may be marked unsupported from a connection failure");
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  socket.close();
  const timer = setTimeout(() => socket.terminate(), 1000);
  timer.unref();
  if (failed) process.exitCode = 1;
}
