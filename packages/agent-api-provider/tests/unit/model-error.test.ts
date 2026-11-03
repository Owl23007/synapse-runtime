import { describe, expect, it } from "vitest";
import { ModelProviderError } from "@synapse/runtime-agent-core";
import { OpenAiCompatibleChatProvider } from "../../src/provider.js";

const options = { id: "test", apiKey: "secret", baseUrl: "https://model.invalid", model: "test" };
describe("模型服务失败分类", () => {
  it.each([408, 429, 500, 503, 599, 400, 401, 403, 404])("按 HTTP %i 分类，不依赖错误消息", async (status) => {
    const provider = new OpenAiCompatibleChatProvider({
      ...options,
      fetch: async () => ({ ok: false, status, json: async () => ({ error: "temporary failure" }) })
    });
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      failure: { kind: "model", code: "http", retryable: [408, 429].includes(status) || status >= 500 }
    });
  });
  it("传输失败可以重试，成功响应格式错误不能伪装为暂时故障", async () => {
    const transport = new OpenAiCompatibleChatProvider({
      ...options,
      fetch: () => {
        throw new TypeError("connection reset");
      }
    });
    await expect(transport.complete({ messages: [] })).rejects.toMatchObject({
      failure: { code: "transport", retryable: true }
    });
    const invalid = new OpenAiCompatibleChatProvider({
      ...options,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
    });
    await expect(invalid.complete({ messages: [] })).rejects.not.toBeInstanceOf(ModelProviderError);
  });
  it("调用方取消不转换为模型服务重试", async () => {
    const cancellation = new Error("cancelled");
    const controller = new AbortController();
    const provider = new OpenAiCompatibleChatProvider({
      ...options,
      fetch: async () => {
        controller.abort(cancellation);
        throw new TypeError("aborted fetch");
      }
    });
    await expect(provider.complete({ messages: [], signal: controller.signal })).rejects.toBe(cancellation);
  });
});
