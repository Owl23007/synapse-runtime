import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "@synapse/runtime-client";
import { initialSessionTitle, presentSession, sessionMessageTime, workspaceSummary } from "./session-presentation.js";
import { messageTime } from "./workspace-model.js";

describe("会话展示兼容", () => {
  it("频道使用会话名称与结构化定位，不使用最后一条消息作为标题", () => {
    expect(presentSession({ id: "qq:napcat:qq-local:group:807754424", title: "11" })).toMatchObject({
      title: "QQ 群聊 · 807754424",
      native: false,
      subtitle: "NapCat · qq-local"
    });
    expect(
      presentSession({
        id: "channel",
        platform: "qq",
        provider: "napcat",
        channelId: "qq-local",
        conversationType: "group",
        conversationId: "42",
        conversationTitle: "硬件设计讨论"
      })
    ).toMatchObject({ title: "硬件设计讨论", badge: "QQ 群聊", native: false });
  });

  it("原生会话保留明确名称，初始化摘要合并空白且不截断 Unicode 字符", () => {
    expect(presentSession({ id: "native-a", channelId: "native", title: "发布计划" })).toMatchObject({
      title: "发布计划",
      native: true
    });
    expect(initialSessionTitle("  分析项目\n依赖关系  ")).toBe("分析项目 依赖关系");
    expect(initialSessionTitle("🙂".repeat(40))).toBe("🙂".repeat(36) + "…");
    expect(initialSessionTitle("")).toBe("新会话");
  });

  it("列表使用最近消息时间而不是创建时间或运行更新时间", () => {
    expect(
      sessionMessageTime({
        createdAt: "2026-07-05T00:00:00Z",
        updatedAt: "2026-10-29T00:00:00Z",
        lastMessageAt: "2026-10-27T01:00:00Z"
      })
    ).toBe("2026-10-27T01:00:00Z");
    expect(sessionMessageTime({ createdAt: "2026-07-05T00:00:00Z", lastMessageAt: null })).toBe("2026-07-05T00:00:00Z");
  });

  it("兼容缓存仅保留元数据与最新时间，历史消息始终显示时刻", () => {
    const view: WorkspaceView = {
      session: { id: "a", mainlineId: "main", status: "active" },
      line: { id: "main", kind: "mainline" },
      branches: [],
      messages: [
        {
          id: "m1",
          sequence: 1,
          type: "user_message",
          createdAt: "2026-10-27T10:00:00+08:00",
          payload: { text: "不应复制进缓存的正文" }
        },
        { id: "m2", sequence: 2, type: "assistant_message", createdAt: "2026-10-27T03:00:00Z", payload: {} }
      ],
      hasMore: false,
      nextCursor: 0
    };
    const summary = workspaceSummary(view);
    expect(summary.lastMessageAt).toBe("2026-10-27T03:00:00Z");
    expect(JSON.stringify(summary)).not.toContain("正文");
    expect(messageTime(new Date(2026, 9, 27, 15, 32).toISOString())).toContain("15:32");
  });
});
