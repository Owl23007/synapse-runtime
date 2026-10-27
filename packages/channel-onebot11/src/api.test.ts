import { describe, expect, it, vi } from "vitest";
import { OneBot11Api } from "./api.js";
import { NapCatApi } from "./napcat.js";
import type { OneBot11Connection } from "./transport.js";

function fixture() {
  const call = vi.fn<OneBot11Connection["call"]>().mockResolvedValue({ status: "ok", retcode: 0 });
  const connection: OneBot11Connection = {
    async connect() {},
    async disconnect() {},
    getStatus() {
      return { state: "online", checkedAt: "" };
    },
    call
  };
  return { call, standard: new OneBot11Api(connection), napcat: new NapCatApi(connection) };
}

describe("标准 API 与 NapCat 扩展隔离", () => {
  it("标准 API 拒绝文件与不支持的片段，不发送扩展请求或丢弃片段", async () => {
    const f = fixture();
    const target = { type: "group", groupId: "42" } as const;
    expect(
      (
        await f.standard.sendMessage(target, {
          type: "file",
          segments: [{ type: "file", name: "a.txt", url: "base64://YQ==" }]
        })
      ).status
    ).toBe("unsupported");
    expect(
      (
        await f.standard.sendMessage(target, {
          type: "audio",
          segments: [{ type: "audio", url: "https://example.test/a.ogg" }]
        })
      ).status
    ).toBe("unsupported");
    expect((await f.standard.sendMessage(target, { type: "text", segments: [] })).status).toBe("failed");
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["failed", "async", "network", "malformed"])("附件成功后说明消息 %s 不能变成可重试失败", async (failure) => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ status: "ok", retcode: 0 });
    if (failure === "network") f.call.mockRejectedValueOnce(new Error("lost"));
    else f.call.mockResolvedValueOnce(failure === "malformed" ? {} : { status: failure, retcode: 1 });
    const result = await f.napcat.sendMessage(
      { type: "group", groupId: "42" },
      {
        type: "mixed",
        segments: [
          { type: "file", name: "a.txt", url: "base64://YQ==" },
          { type: "text", text: "done" }
        ]
      },
      f.standard
    );
    expect(result.status).toBe("uncertain");
    expect(f.call.mock.calls.map(([action]) => action)).toEqual(["upload_group_file", "send_msg"]);
  });

  it("扩展拒绝回执不泄露平台回显的文件内容", async () => {
    const f = fixture();
    f.call.mockResolvedValue({ status: "failed", retcode: 1200, message: "private base64 contents" });
    const receipt = await f.napcat.uploadGroupFile("42", { name: "a.txt", data: new Uint8Array([1]) });
    expect(receipt).toMatchObject({ status: "failed" });
    expect(JSON.stringify(receipt)).not.toContain("private base64 contents");
  });
});
