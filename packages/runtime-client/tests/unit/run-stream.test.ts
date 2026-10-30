import { describe, expect, it } from "vitest";
import { RuntimeAdminClient } from "../../src/admin-client.js";
import type { AdminFetchInit } from "../../src/admin-client-types.js";

function body(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    }
  });
}
function event(cursor: number): string {
  return `id: ${cursor}\nevent: run_event\ndata: ${JSON.stringify({ id: `event-${cursor}`, protocolVersion: 1, cursor, seq: cursor, runId: "run-a", data: { text: "中文" } })}\n\n`;
}

describe("持久运行流客户端", () => {
  it("重连携带最后处理的游标，拆包和重复事件不会漏读", async () => {
    const requests: (AdminFetchInit | undefined)[] = [];
    const received: number[] = [];
    const client = new RuntimeAdminClient({
      endpoint: "http://runtime",
      token: "secret",
      fetch: async (_url, init) => {
        requests.push(init);
        const text =
          requests.length === 1
            ? `event: snapshot\ndata: {"protocolVersion":1,"cursor":0,"highWaterMark":2,"runs":[]}\n\n${event(1)}${event(2)}`
            : event(2) + event(3);
        return {
          ok: true,
          status: 200,
          body: body(text),
          async json() {
            return {};
          }
        };
      }
    });
    let stop = () => {};
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("reconnect timeout"));
      }, 3_000);
      stop = client.streamRuns({
        onEvent(value) {
          received.push(value.cursor);
          if (value.cursor === 3) {
            stop();
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    expect(received).toEqual([1, 2, 3]);
    expect(requests[1]?.headers).toMatchObject({ authorization: "Bearer secret", "last-event-id": "2" });
    expect(requests[1]?.signal?.aborted).toBe(true);
  });

  it("认证失败停止重连并报告状态", async () => {
    let requests = 0;
    const states: string[] = [];
    const client = new RuntimeAdminClient({
      endpoint: "http://runtime",
      fetch: async () => {
        requests++;
        return {
          ok: false,
          status: 401,
          async json() {
            return {};
          }
        };
      }
    });
    let stop = () => {};
    await new Promise<void>((resolve) => {
      stop = client.streamRuns({
        onEvent() {},
        onState(state) {
          states.push(state);
          if (state === "unauthorized") resolve();
        }
      });
    });
    stop();
    expect(requests).toBe(1);
    expect(states).toContain("unauthorized");
  });
});
