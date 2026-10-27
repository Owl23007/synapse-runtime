import { once } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { OneBot11WebSocketTransport } from "./websocket-transport.js";

describe("真实 WebSocket 发送回调兼容", () => {
  it.each(["send_msg", "upload_group_file"])("%s 等待平台回执而不把 null 成功回调当作失败", async (action) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("测试服务器未监听 TCP 端口");
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data: Buffer) => {
        const request = JSON.parse(data.toString()) as { action: string; echo: string };
        socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { action: request.action } }));
      });
    });
    const transport = new OneBot11WebSocketTransport(
      { id: "qq", endpoint: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 1000 },
      async () => undefined
    );
    try {
      await transport.connect();
      await expect(transport.call(action, {})).resolves.toMatchObject({
        status: "ok",
        retcode: 0,
        data: { action }
      });
    } finally {
      await transport.disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
