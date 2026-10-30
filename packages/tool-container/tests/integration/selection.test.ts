import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts.js";
import { ContainerSettingsSchema } from "../../src/config.js";

describe("最终工件选择与去重", () => {
  it("同轮同名同内容复用 ID，修订版替换选择且重启不丢失废弃记录", () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-final-artifacts-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const settings = ContainerSettingsSchema.parse({});
    const store = new ArtifactStore(directory, settings);
    const scope = { sessionId: "group", runId: "run", callId: "first" };
    try {
      const first = store.save(scope, [{ name: "report.txt", data: Buffer.from("v1") }])[0]!;
      const duplicate = store.save({ ...scope, callId: "retry" }, [
        { name: "report.txt", data: Buffer.from("v1") }
      ])[0]!;
      expect(duplicate.id).toBe(first.id);
      expect(readdirSync(directory).filter((name) => name.endsWith(".bin"))).toHaveLength(1);
      const revised = store.save({ ...scope, callId: "revision" }, [
        { name: "report.txt", data: Buffer.from("v2") }
      ])[0]!;
      expect(store.selection("group", "run")).toMatchObject({ selectedIds: [revised.id], excludedIds: [first.id] });
      const extra = store.save(scope, [{ name: "draft.txt", data: Buffer.from("draft") }])[0]!;
      store.discard("group", "run", [extra.id]);
      const reopened = new ArtifactStore(directory, settings);
      expect(reopened.describe("group", extra.id).disposition).toBe("discarded");
      expect(reopened.select("group", "run", [first.id])).toMatchObject({
        selectedIds: [first.id],
        discardedIds: [extra.id]
      });
      expect(reopened.read("group", revised.id).data).toEqual(Buffer.from("v2"));
      expect(() => reopened.select("other-group", "run", [first.id])).toThrow("当前会话");
      expect(() => reopened.discard("group", "other-run", [first.id])).toThrow("当前运行");
      expect(reopened.selection("group", "run").selectedIds).toEqual([first.id]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("存储额度已满仍可复用同一工件，但不会跨会话或跨运行复用身份", () => {
    const directory = mkdtempSync(join(tmpdir(), "synapse-dedup-quota-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    try {
      const store = new ArtifactStore(directory, { ...ContainerSettingsSchema.parse({}), storageMaxBytes: 2 });
      const file = { name: "a.txt", data: Buffer.from("hi") };
      const scope = { sessionId: "group", runId: "run", callId: "call" };
      const first = store.save(scope, [file]);
      expect(store.save(scope, [file])).toEqual(first);
      expect(() => store.save({ ...scope, runId: "next" }, [file])).toThrow("配额");
      expect(() => store.save({ ...scope, sessionId: "other" }, [file])).toThrow("配额");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
