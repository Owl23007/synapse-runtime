import { onTestFinished, describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../../../src/storage/sqlite/runtime-context-store.js";
import { ResourceIngress } from "../../../src/assets/ingress.js";

describe("独立文件入口", () => {
  it("幂等索引通知与未触发的文件消息且不创建转录或运行", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:" });
    onTestFinished(() => store.close());
    try {
      const ingress = new ResourceIngress(store.assets, store, store);
      const notice = {
        channelId: "qq",
        platform: "qq",
        provider: "napcat",
        conversation: { kind: "group" as const, id: "42" },
        file: { fileId: "file", name: "报告.pdf", size: 123, busid: "102" },
        senderId: "sender",
        observedAt: "2026-10-30T00:00:00.000Z",
        sourceEventId: "message"
      };
      const first = await ingress.receive(notice);
      expect((await ingress.receive(notice)).id).toBe(first.id);
      await ingress.receiveMessage(
        {
          id: "message",
          platform: "qq",
          channelId: "qq",
          eventType: "message.created",
          conversation: { id: "42", kind: "group" },
          sender: { id: "sender" },
          receivedAt: notice.observedAt,
          message: {
            id: "message",
            type: "mixed",
            segments: [
              { type: "file", name: "报告.pdf", fileId: "file" },
              { type: "text", text: "未触发的正文不保存" }
            ]
          }
        },
        "napcat"
      );
      expect(store.assets.list(first.workspaceId).items).toHaveLength(1);
      expect(store.assets.get(first.workspaceId, first.id)).toMatchObject({
        currentVersionId: null,
        declaredSizeBytes: 123
      });
      expect(store.assets.sources(first.workspaceId, first.id)[0]?.locator.busid).toBe("102");
      for (const table of [
        "normalized_events",
        "conversation_messages",
        "conversation_sessions",
        "run_traces",
        "asset_versions"
      ])
        expect(store.assets.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      expect(store.assets.db.prepare("SELECT count(*) AS count FROM asset_refs").get()).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });
});
