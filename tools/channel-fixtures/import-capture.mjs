/* oxlint-disable no-await-in-loop -- 同名采集按输入顺序保留最后一条，避免并行写入造成证据覆盖不确定 */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// 只接受本仓库探测器输出的脱敏 JSONL，不能把服务日志或原始网络流量当作 fixture 导入
assert.ok(process.argv[2], "Usage: node tools/channel-fixtures/import-capture.mjs <sanitized.jsonl>");
const lines = (await readFile(process.argv[2], "utf8")).split(/\r?\n/).filter((line) => line.startsWith("{"));
for (const line of lines) {
  const fixture = JSON.parse(line);
  assert.equal(fixture.schemaVersion, "channel-protocol-fixture/v1");
  assert.equal(fixture.channel, "onebot11");
  assert.equal(fixture.provenance.source, "tools/channel-fixtures/probe-napcat.mjs");
  assert.ok(["inbound", "outbound", "errors"].includes(fixture.direction));
  assert.match(fixture.capability, /^[a-z0-9-]+$/);
  const directory = resolve(import.meta.dirname, "../../fixtures/onebot11", fixture.direction);
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, `${fixture.capability}.live.fixture.json`),
    JSON.stringify(fixture, null, 2) + "\n"
  );
  console.log(`${fixture.status}: ${fixture.capability}`);
}
