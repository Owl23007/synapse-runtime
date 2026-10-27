import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import {
  normalizeOneBot11Event,
  createOneBot11SendParams,
  textMessage
} from "../../packages/channel-onebot11/dist/index.js";
import { decodeOneBot11Response, isOneBot11Success } from "../../packages/channel-onebot11/dist/codec.js";
import { normalizeQqOfficialDispatch } from "../../packages/channel-qq-official/dist/index.js";

const root = resolve(import.meta.dirname, "../../fixtures");
async function collect(directory) {
  const results = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? collect(path)
        : entry.name.endsWith(".fixture.json")
          ? [JSON.parse(await readFile(path, "utf8"))]
          : [];
    })
  );
  return results.flat();
}
const fixtures = await collect(root);
const byCapability = (channel, capability) => {
  const fixture = fixtures.find(
    (item) =>
      item.channel === channel && item.capability === capability && item.provenance.kind !== "official-documentation"
  );
  assert.ok(fixture, `Missing captured fixture: ${channel}/${capability}`);
  return fixture;
};

for (const fixture of fixtures.filter((item) => item.channel === "onebot11" && item.artifacts.platformResponse)) {
  test(`replay receipt: ${fixture.id}`, () => {
    const { platformRequest: request, platformResponse: raw } = fixture.artifacts;
    const response = decodeOneBot11Response(raw);
    assert.equal(response.echo, request.echo, "WebSocket 回执必须关联原请求");
    if (raw.status === "ok") {
      assert.equal(response.retcode, 0);
      assert.equal(isOneBot11Success(response), true);
      if (request.action === "send_msg") assert.ok(response.data.message_id);
    } else {
      assert.equal(response.status, "failed");
      assert.notEqual(response.retcode, 0);
      assert.equal(isOneBot11Success(response), false);
    }
  });
}

test("real incoming private snapshot preserves sender, text and external message identity", () => {
  const fixture = byCapability("onebot11", "history-private-input-1");
  const payload = fixture.artifacts.platformEvent;
  const event = normalizeOneBot11Event("capture", payload);
  assert.equal(event.sender.id, "<user-1>");
  assert.equal(event.conversation.id, "<user-1>");
  assert.equal(event.conversation.kind, "private");
  assert.equal(event.externalEventId, payload.message_id);
  assert.equal(event.triggerHint.platformEventType, "message.private");
  assert.deepEqual(event.message.segments, [{ type: "text", text: "fixture protocol text 输入测试" }]);
});

for (const kind of ["private", "group"]) {
  test(`actual ${kind} send parameters match adapter encoding`, () => {
    const request = byCapability("onebot11", `send-${kind}-text`).artifacts.platformRequest;
    const target =
      kind === "group"
        ? { type: kind, groupId: request.params.group_id }
        : { type: kind, userId: request.params.user_id };
    assert.deepEqual(createOneBot11SendParams(target, textMessage(request.params.message)), request.params);
  });
  test(`queried ${kind} sent snapshot preserves outgoing origin and decodes CQ escaping once`, () => {
    const payload = byCapability("onebot11", `get-${kind}-message`).artifacts.platformResponse.data;
    const event = normalizeOneBot11Event("capture", payload);
    assert.equal(payload.post_type, "message_sent");
    assert.equal(event.triggerHint.platformEventType, `message_sent.${kind}`);
    assert.equal(event.sender.id, event.triggerHint.selfUserId);
    assert.equal(event.message.segments[0].text, `fixture protocol text ${kind} 中文 & [text]`);
    assert.match(payload.raw_message, /&amp;.*&#91;text&#93;/);
  });
}

for (const fixture of fixtures.filter((item) => item.direction === "inbound" && item.status === "documented")) {
  test(`documentation seed still normalizes: ${fixture.id}`, () => {
    const event =
      fixture.channel === "onebot11"
        ? normalizeOneBot11Event("seed", fixture.artifacts.platformEvent)
        : normalizeQqOfficialDispatch("seed", fixture.artifacts.platformEvent);
    assert.equal(event.eventType, "message.created");
    assert.ok(event.message.segments.length > 0);
  });
}

test("CLI evidence keeps success JSON and authentication errors on separate streams", () => {
  for (const name of ["status", "channels"]) {
    const output = byCapability("cli", name).artifacts.terminalOutput;
    assert.equal(output.exitCode, 0);
    assert.equal(output.stderr, "");
    assert.equal(output.stdout.ok, true);
  }
  const output = byCapability("cli", "unauthorized").artifacts.terminalOutput;
  assert.equal(output.exitCode, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /401/);
  assert.equal(byCapability("cli", "unknown-command").status, "tested-partial");
  assert.match(byCapability("cli", "unknown-argument").artifacts.terminalOutput.stderr, /Unknown argument/);
});

test("captured TUI quit disconnects the client while attached service remains alive", () => {
  assert.deepEqual(byCapability("cli", "tui-attached-quit").artifacts.terminalOutput, {
    result: "exit",
    status: "stopped",
    runtimeHealthHttpStatus: 200
  });
  assert.match(byCapability("cli", "tui-plain-text").artifacts.terminalOutput.notices[0], /Unknown command/);
});
