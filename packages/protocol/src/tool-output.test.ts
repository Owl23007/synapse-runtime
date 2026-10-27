import { describe, expect, it } from "vitest";
import { readToolOutput } from "./tool-output.js";

describe("versioned tool output", () => {
  it("requires verified resource data rather than an arbitrary filename or local path", () => {
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
