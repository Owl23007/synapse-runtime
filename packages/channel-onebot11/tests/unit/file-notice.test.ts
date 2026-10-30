import { describe, expect, it } from "vitest";
import { normalizeOneBot11FileNotice, normalizeOneBot11Event } from "../../src/normalize.js";

describe("OneBot11 文件通知规范化", () => {
  it("区分真实群上传与消息事件并规范化平台标识", () => {
    const payload = {
      post_type: "notice",
      notice_type: "group_upload",
      group_id: 42,
      user_id: 7,
      time: 1793318400,
      file: { id: "platform-file", name: "需求.pdf", size: 123, busid: 102 }
    };
    expect(normalizeOneBot11Event("qq", payload)).toBeUndefined();
    expect(normalizeOneBot11FileNotice("qq", "napcat", payload)).toMatchObject({
      channelId: "qq",
      provider: "napcat",
      conversation: { kind: "group", id: "42" },
      senderId: "7",
      file: { fileId: "platform-file", name: "需求.pdf", size: 123, busid: "102" }
    });
    expect(normalizeOneBot11FileNotice("qq", "napcat", { ...payload, file: { name: "missing-id" } })).toBeUndefined();
    expect(normalizeOneBot11FileNotice("qq", "napcat", { ...payload, post_type: "message" })).toBeUndefined();
  });
});
