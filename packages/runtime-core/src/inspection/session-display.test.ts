import { describe, expect, it } from "vitest";
import { SqliteRuntimeContextStore } from "../storage/sqlite/runtime-context-store.js";

describe("会话列表展示字段", () => {
  it("提供定位与最近消息时间，工具事件不影响时间且保留创建游标", async () => {
    const store = new SqliteRuntimeContextStore({ databasePath: ":memory:", traceSecrets: ["private-name"] });
    try {
      const first = await store.createSession({
        id: "channel-a",
        locator: {
          platform: "qq",
          provider: "napcat",
          channelId: "qq-local",
          conversationType: "group",
          conversationId: "42"
        },
        metadata: { conversationTitle: "private-name" },
        createdAt: "2026-07-05T00:00:00Z"
      });
      await store.createSession({
        id: "native-b",
        locator: {
          platform: "native",
          provider: "native",
          channelId: "native",
          conversationType: "private",
          conversationId: "native-b"
        },
        metadata: { title: "原生会话" },
        createdAt: "2026-10-28T00:00:00Z"
      });
      await store.appendEvent(first.mainlineId, {
        type: "assistant_message",
        payload: { text: "回复" },
        idempotencyKey: "last-message",
        createdAt: "2026-10-27T12:35:00+08:00"
      });
      await store.appendEvent(first.mainlineId, {
        type: "tool_result",
        payload: { output: "ok" },
        idempotencyKey: "later-tool",
        createdAt: "2026-10-29T00:00:00Z"
      });
      const rows = store.inspectSessions(1) as Record<string, unknown>[];
      expect(rows[0]).toMatchObject({ id: "native-b", platform: "native", lastMessageAt: null, title: "原生会话" });
      const older = store.inspectSessions(1, Number(rows[0]?.cursor)) as Record<string, unknown>[];
      expect(older[0]).toMatchObject({
        id: "channel-a",
        platform: "qq",
        provider: "napcat",
        conversationId: "42",
        conversationType: "group",
        lastMessageAt: "2026-10-27T12:35:00+08:00"
      });
      expect(JSON.stringify(older)).not.toContain("private-name");
    } finally {
      store.close();
    }
  });
});
