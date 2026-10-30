import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished, describe, expect, it } from "vitest";
import { createSafeFetch } from "../../src/safe-fetch.js";

async function createHttpServerFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://localhost/secret" }).end();
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200);
      response.write("0123456789");
      response.end("0123456789");
      return;
    }
    response.end("hello");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("受限且绑定 DNS 的 HTTP", () => {
  it("拒绝私有目标与凭据除非主机获得显式批准", async () => {
    const endpoint = await createHttpServerFixture();
    const fetch = createSafeFetch({ maxBytes: 100 });
    await expect(fetch(endpoint)).rejects.toThrow("private");
    await expect(fetch("file:///etc/passwd")).rejects.toThrow();
    await expect(fetch("http://user:secret@127.0.0.1")).rejects.toThrow();
    const allowed = createSafeFetch({ maxBytes: 100, privateHosts: ["127.0.0.1"], allowedHosts: ["127.0.0.1"] });
    expect(await (await allowed(endpoint)).text()).toBe("hello");
    await expect(allowed(endpoint + "/redirect")).rejects.toThrow("not allowed");
  });
  it("限制流式响应且不信任内容长度头", async () => {
    const endpoint = await createHttpServerFixture();
    const fetch = createSafeFetch({ maxBytes: 10, privateHosts: ["127.0.0.1"] });
    const response = await fetch(endpoint + "/large");
    await expect(response.text()).rejects.toThrow("too large");
  });
});
