import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSafeFetch } from "./safe-fetch.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function server() {
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
  closes.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe("bounded DNS-pinned HTTP", () => {
  it("rejects private targets and credentials unless a host was explicitly approved", async () => {
    const endpoint = await server();
    const fetch = createSafeFetch({ maxBytes: 100 });
    await expect(fetch(endpoint)).rejects.toThrow("private");
    await expect(fetch("file:///etc/passwd")).rejects.toThrow();
    await expect(fetch("http://user:secret@127.0.0.1")).rejects.toThrow();
    const allowed = createSafeFetch({ maxBytes: 100, privateHosts: ["127.0.0.1"], allowedHosts: ["127.0.0.1"] });
    expect(await (await allowed(endpoint)).text()).toBe("hello");
    await expect(allowed(endpoint + "/redirect")).rejects.toThrow("not allowed");
  });
  it("bounds streamed responses rather than trusting Content-Length", async () => {
    const endpoint = await server();
    const fetch = createSafeFetch({ maxBytes: 10, privateHosts: ["127.0.0.1"] });
    const response = await fetch(endpoint + "/large");
    await expect(response.text()).rejects.toThrow("too large");
  });
});
