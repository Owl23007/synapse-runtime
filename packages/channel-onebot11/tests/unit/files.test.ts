import { describe, expect, it } from "vitest";
import { OneBot11ChannelAdapter } from "../../src/adapter.js";

describe("OneBot 文件交付", () => {
  it("非 NapCat 提供方不能调用文件上传扩展", async () => {
    let calls = 0;
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      provider: "other",
      transport: "http",
      endpoint: "http://localhost:5700",
      fetch: async () => {
        calls += 1;
        return Response.json({ status: "ok", retcode: 0 });
      }
    });
    expect(adapter.getCapabilities().capabilities["file.upload"]?.status).toBe("unsupported");
    expect(
      await adapter.sendMessage(
        { type: "group", groupId: "42" },
        { type: "file", segments: [{ type: "file", name: "a.txt", url: "base64://aGk=" }] }
      )
    ).toMatchObject({ status: "unsupported" });
    expect(calls).toBe(0);
  });
  it.each(["async", "network", "partial"])("%s 文件交付结果不确定时停止恢复", async (failure) => {
    let calls = 0;
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://localhost:5700",
      fetch: async () => {
        calls += 1;
        if (failure === "network") throw new Error("transport lost");
        if (failure === "partial" && calls === 1) return Response.json({ status: "ok", retcode: 0 });
        return Response.json({ status: failure === "partial" ? "failed" : "async", retcode: 1 });
      }
    });
    await expect(
      adapter.sendMessage(
        { type: "group", groupId: "42" },
        {
          type: "file",
          segments: [
            { type: "file", name: "first.txt", url: "base64://aGk=" },
            { type: "file", name: "second.txt", url: "base64://aGk=" }
          ]
        }
      )
    ).resolves.toMatchObject({ status: "uncertain", error: expect.stringContaining("回执未确认") });
    expect(calls).toBe(failure === "partial" ? 2 : 1);
  });

  it.each(["group", "private"] as const)("先上传 %s 文件再发送文本", async (kind) => {
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
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(calls.map((call) => call.action)).toEqual([`upload_${kind}_file`, "send_msg"]);
    expect(calls[0]?.params).toMatchObject({ file: "base64://aGk=", name: "demo.txt" });
  });

  it("报告上传拒绝且不在后续消息中宣称已交付", async () => {
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
    ).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("upload failed") });
    expect(calls).toHaveLength(1);
  });

  it("接受仅文件回复且不发送空消息", async () => {
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
    ).resolves.toEqual({ status: "succeeded" });
    expect(calls).toHaveLength(1);
  });
});
