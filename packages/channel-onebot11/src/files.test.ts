import { describe, expect, it } from "vitest";
import { OneBot11ChannelAdapter } from "./adapter.js";

describe("OneBot file delivery", () => {
  it.each(["group", "private"] as const)("uploads %s files before sending text", async (kind) => {
    const calls: { action: string; params: unknown }[] = [];
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://localhost:5700",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "ok", retcode: 0, data: { message_id: "1" } });
      }
    });
    await expect(
      adapter.sendMessage(kind === "group" ? { type: kind, groupId: "42" } : { type: kind, userId: "42" }, {
        type: "mixed",
        segments: [
          { type: "text", text: "完成" },
          { type: "file", name: "demo.txt", url: "base64://aGk=" }
        ]
      })
    ).resolves.toMatchObject({ ok: true });
    expect(calls.map((call) => call.action)).toEqual([`upload_${kind}_file`, "send_msg"]);
    expect(calls[0]?.params).toMatchObject({ file: "base64://aGk=", name: "demo.txt" });
  });

  it("reports upload rejection without claiming delivery in a subsequent message", async () => {
    const calls: unknown[] = [];
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://localhost:5700",
      fetch: async (_url, init) => {
        calls.push(init?.body);
        return Response.json({ status: "failed", retcode: 1, message: "upload failed" });
      }
    });
    await expect(
      adapter.sendMessage(
        { type: "group", groupId: "42" },
        {
          type: "mixed",
          segments: [
            { type: "text", text: "完成" },
            { type: "file", name: "demo.txt", url: "base64://aGk=" }
          ]
        }
      )
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("upload failed") });
    expect(calls).toHaveLength(1);
  });

  it("accepts a file-only reply without attempting empty send_msg", async () => {
    const calls: string[] = [];
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://localhost:5700",
      fetch: async (url) => {
        calls.push(String(url));
        return Response.json({ status: "ok", retcode: 0 });
      }
    });
    await expect(
      adapter.sendMessage(
        { type: "private", userId: "42" },
        { type: "file", segments: [{ type: "file", name: "demo.txt", url: "base64://aGk=" }] }
      )
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});
