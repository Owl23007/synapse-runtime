import { describe, expect, it } from "vitest";
import { readToolOutput } from "../../src/tool-output.js";

describe("版本化工具输出", () => {
  it("要求已验证的资源数据且拒绝任意文件名或本地路径", () => {
    expect(readToolOutput({ attachments: [{ type: "file", name: "fake.pptx" }] })).toBeUndefined();
    expect(
      readToolOutput({
        schemaVersion: "runtime-tool-output/v1",
        modelOutput: {},
        attachments: [{ type: "file", name: "secret", url: "file:///secret" }]
      })
    ).toBeUndefined();
    expect(
      readToolOutput({
        schemaVersion: "runtime-tool-output/v1",
        modelOutput: {},
        attachments: [{ type: "image", url: "base64://aGk=" }]
      })
    ).toBeDefined();
  });
});
