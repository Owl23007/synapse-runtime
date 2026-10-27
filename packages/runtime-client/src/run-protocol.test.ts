import { expect, it, vi } from "vitest";
import { RuntimeAdminClient } from "./admin-client.js";
import type { AdminFetch } from "./admin-client-types.js";

it("不兼容协议停止订阅并释放读取器，不进入无限重连", async () => {
  const cancel = vi.fn<() => void>();
  const fetch = vi.fn<AdminFetch>(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: snapshot\ndata: {"protocolVersion":2,"cursor":0,"runs":[]}\n\n')
        );
      },
      cancel
    })
  }));
  const client = new RuntimeAdminClient({ endpoint: "http://runtime", fetch });
  const onError = vi.fn<(error: Error) => void>();
  let stop = () => {};
  await new Promise<void>((resolve) => {
    stop = client.streamRuns({
      onEvent() {},
      onError,
      onState(state) {
        if (state === "incompatible") resolve();
      }
    });
  });
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("协议版本") }));
  stop();
});
