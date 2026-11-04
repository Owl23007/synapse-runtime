import { describe, expect, it } from "vitest";
import { OpenAiCompatibleChatProvider } from "../../src/index.js";

const encoder = new TextEncoder();
function frame(delta: unknown, finish_reason: string | null = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
}
function provider(response: Response, capture?: (body: string) => void) {
  return new OpenAiCompatibleChatProvider({
    id: "stream-test",
    apiKey: "test",
    baseUrl: "https://model.example/v1",
    model: "test",
    fetch: async (_url, init) => {
      capture?.(init?.body ?? "");
      return response;
    }
  });
}

describe("模型 SSE 正文与工具流", () => {
  it("跨 UTF-8 字节和 SSE 帧边界合并正文、交错工具参数与末尾用量", async () => {
    const text =
      frame({ content: "你好，" }) +
      frame({
        content: "**世界**",
        tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: '{"b":' } }]
      }) +
      frame(
        {
          tool_calls: [
            { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
            { index: 1, function: { arguments: "2}" } }
          ]
        },
        "tool_calls"
      ) +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = encoder.encode(text);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) controller.close();
        else {
          controller.enqueue(bytes.slice(offset, offset + 7));
          offset += 7;
        }
      }
    });
    let request: Record<string, unknown> = {};
    const deltas: string[] = [];
    const result = await provider(new Response(body, { headers: { "content-type": "text/event-stream" } }), (value) => {
      request = JSON.parse(value);
    }).complete({
      messages: [],
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });
    expect(deltas).toEqual(["你好，", "**世界**"]);
    expect(result).toMatchObject({
      content: "你好，**世界**",
      finishReason: "tool_calls",
      usage: { totalTokens: 15 },
      toolCalls: [
        { id: "a", name: "first", arguments: {} },
        { id: "b", name: "second", arguments: { b: 2 } }
      ]
    });
    expect(request).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(request).not.toHaveProperty("onTextDelta");
  });

  it("完成回执到达前即可观察正文，生成期间不提前返回成功", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      }
    });
    const deltas: string[] = [];
    let finished = false;
    const result = provider(new Response(body, { headers: { "content-type": "text/event-stream" } }))
      .complete({
        messages: [],
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      })
      .then((value) => {
        finished = true;
        return value;
      });
    stream.enqueue(encoder.encode(frame({ content: "第一段" })));
    await expect.poll(() => deltas.join("")).toBe("第一段");
    expect(finished).toBe(false);
    stream.enqueue(encoder.encode(frame({ content: "第二段" }, "stop") + "data: [DONE]\n\n"));
    stream.close();
    expect((await result).content).toBe("第一段第二段");
  });

  it("缺少完成回执时拒绝执行仅收到部分参数的工具", async () => {
    const response = new Response(
      frame({ tool_calls: [{ index: 0, id: "a", function: { name: "write", arguments: '{"path":' } }] }),
      { headers: { "content-type": "text/event-stream" } }
    );
    await expect(provider(response).complete({ messages: [], onTextDelta() {} })).rejects.toThrow("未收到完成回执");
  });

  it("取消会停止读取，兼容返回完整 JSON 的网关", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const controller = new AbortController();
    const result = provider(new Response(body, { headers: { "content-type": "text/event-stream" } })).complete({
      messages: [],
      signal: controller.signal,
      onTextDelta() {}
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => cancelled).toBe(true);
    await expect(
      provider(Response.json({ choices: [{ message: { content: "完整响应" } }] })).complete({
        messages: [],
        onTextDelta() {}
      })
    ).resolves.toMatchObject({ content: "完整响应" });
  });
});
