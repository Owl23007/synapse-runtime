import { describe, expect, it } from "vitest";
import { normalizeOneBot11FileNotice, normalizeOneBot11Event } from "./normalize.js";

describe("OneBot11 file notice normalization", () => {
  it("keeps real group uploads separate from message events and normalizes platform identifiers", () => {
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
