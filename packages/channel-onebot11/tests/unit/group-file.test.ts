import { describe, expect, it } from "vitest";
import { OneBot11ChannelAdapter } from "../../src/adapter.js";

describe("NapCat 群文件上传", () => {
  it("按平台协议传输内容并保留文件回执", async () => {
    let request: unknown;
    const adapter = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://napcat.invalid",
      fetch: async (_url, options) => {
        request = JSON.parse(options!.body!);
        return {
          ok: true,
          status: 200,
          async json() {
            return { status: "ok", retcode: 0, data: { file_id: "file-id" } };
          }
        };
      }
    });
    expect(await adapter.uploadGroupFile("123", { name: "报告.csv", data: Buffer.from("a,b") })).toEqual({
      status: "succeeded",
      fileId: "file-id"
    });
    expect(request).toEqual({
      action: "upload_group_file",
      params: { group_id: "123", name: "报告.csv", file: "base64://YSxi", upload_file: true }
    });
  });

  it("保留明确拒绝和结果未知的区别，不降级成文本链接", async () => {
    const reject = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://napcat.invalid",
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { status: "failed", retcode: 1200, message: "quota" };
        }
      })
    });
    expect((await reject.uploadGroupFile("123", { name: "a.txt", data: Buffer.from("a") })).status).toBe("failed");
    const unknown = new OneBot11ChannelAdapter({
      id: "qq",
      transport: "http",
      endpoint: "http://napcat.invalid",
      fetch: async () => {
        throw new Error("timeout");
      }
    });
    expect((await unknown.uploadGroupFile("123", { name: "a.txt", data: Buffer.from("a") })).status).toBe("uncertain");
    const unsupported = new OneBot11ChannelAdapter({ id: "qq", provider: "other", endpoint: "ws://unused" });
    expect((await unsupported.uploadGroupFile("123", { name: "a.txt", data: Buffer.from("a") })).status).toBe(
      "unsupported"
    );
    expect((await unknown.uploadGroupFile("123", { name: "../../private", data: Buffer.from("a") })).status).toBe(
      "failed"
    );
    expect((await unknown.uploadGroupFile("123", { name: "empty.txt", data: Buffer.alloc(0) })).status).toBe("failed");
  });
});
