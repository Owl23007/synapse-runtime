import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigObject } from "@synapse/runtime-config";
import { RuntimeServer, loadEnvFile, type RuntimeFetch } from "./index.js";

const servers: RuntimeServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers.length = 0;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeServer", () => {
  it("handles QQ official webhooks and replies through the configured agent", async () => {
    const sentMessages: unknown[] = [];
    const fetch: RuntimeFetch = async (url, init) => {
      if (url === "https://bots.qq.com/app/getAppAccessToken") {
        return jsonResponse({ access_token: "token-1", expires_in: 7200 });
      }

      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        sentMessages.push({
          headers: init?.headers,
          body: init?.body
        });
        return jsonResponse({ id: "sent-1" });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { enabled: false },
      agent: {
        default: "echo",
        providers: {
          echo: {
            type: "echo",
            prefix: "echo: "
          }
        }
      },
      conversation: {
        privateTrigger: { mode: "always" },
        groupTrigger: { mode: "always" }
      },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret",
          enabled: true
        }
      },
      permissions: {
        "channel.qq.send_private_message": "allow"
      }
    });
    const server = new RuntimeServer({ config, fetch, awaitDispatch: true, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    await expect(fetchJson(`${baseUrl}/health`)).resolves.toEqual({ ok: true });

    const validation = await fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
      method: "POST",
      body: JSON.stringify({
        op: 13,
        d: {
          plain_token: "plain-token",
          event_ts: "1700000000"
        }
      })
    });

    expect(validation).toMatchObject({ plain_token: "plain-token" });
    expect((validation as { signature?: unknown }).signature).toEqual(expect.any(String));

    await expect(
      fetchStatus(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: JSON.stringify({
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          d: {
            id: "event-unsigned",
            msg_id: "message-unsigned",
            user_openid: "user-openid",
            content: "hello"
          }
        })
      })
    ).resolves.toBe(401);

    await expect(
      fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: signedQqBody("app-secret", {
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          d: {
            id: "event-1",
            msg_id: "message-1",
            user_openid: "user-openid",
            content: "hello"
          }
        })
      })
    ).resolves.toEqual({ op: 12 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      headers: {
        authorization: "QQBot token-1",
        "content-type": "application/json"
      }
    });
    expect(JSON.parse((sentMessages[0] as { body: string }).body)).toMatchObject({
      content: "echo: hello",
      msg_type: 0,
      msg_id: "message-1"
    });
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toEqual(expect.any(Number));
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toBeGreaterThanOrEqual(0);
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toBeLessThanOrEqual(65_535);
    expect(sentMessages).toMatchObject([
      {
        headers: {
          authorization: "QQBot token-1",
          "content-type": "application/json"
        }
      }
    ]);
  });

  it("treats QQ official group messages with mentions as group mention triggers", async () => {
    const sentMessages: unknown[] = [];
    const fetch: RuntimeFetch = async (url, init) => {
      if (url === "https://bots.qq.com/app/getAppAccessToken") {
        return jsonResponse({ access_token: "token-1", expires_in: 7200 });
      }

      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/messages") {
        sentMessages.push({
          headers: init?.headers,
          body: init?.body
        });
        return jsonResponse({ id: "sent-1" });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { enabled: false },
      agent: {
        default: "echo",
        providers: {
          echo: {
            type: "echo",
            prefix: "echo: "
          }
        }
      },
      conversation: {
        privateTrigger: { mode: "always" },
        groupTrigger: { mode: "mention", botUserIds: ["bot-openid"] }
      },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret",
          enabled: true
        }
      },
      permissions: {
        "channel.qq.send_group_message": "allow"
      }
    });
    const server = new RuntimeServer({ config, fetch, awaitDispatch: true, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    await expect(
      fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: signedQqBody("app-secret", {
          op: 0,
          t: "GROUP_MESSAGE_CREATE",
          d: {
            id: "event-1",
            msg_id: "message-1",
            group_openid: "group-openid",
            content: "<@bot-openid> hello",
            mentions: [{ id: "bot-openid" }]
          }
        })
      })
    ).resolves.toEqual({ op: 12 });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      headers: {
        authorization: "QQBot token-1",
        "content-type": "application/json"
      }
    });
    expect(JSON.parse((sentMessages[0] as { body: string }).body)).toMatchObject({
      content: "echo: <@bot-openid> hello",
      msg_type: 0,
      msg_id: "message-1"
    });
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toEqual(expect.any(Number));
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toBeGreaterThanOrEqual(0);
    expect(JSON.parse((sentMessages[0] as { body: string }).body).msg_seq).toBeLessThanOrEqual(65_535);
    expect(sentMessages).toMatchObject([
      {
        headers: {
          authorization: "QQBot token-1",
          "content-type": "application/json"
        }
      }
    ]);
  });

  it("accepts the QQ official signature demo payload", async () => {
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { enabled: false },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "naOC0ocQE3shWLAfffVLB1rhYPG7",
          enabled: true
        }
      }
    });
    const server = new RuntimeServer({ config, awaitDispatch: true, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;

    await expect(
      fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        headers: {
          "x-signature-timestamp": "1725442341",
          "x-signature-ed25519":
            "865ad13a61752ca65e26bde6676459cd36cf1be609375b37bd62af366e1dc25a8dc789ba7f14e017ada3d554c671a911bfdf075ba54835b23391d509579ed002"
        },
        body: '{\n  "op": 0,\n  "d": {},\n  "t": "GATEWAY_EVENT_NAME"\n}'
      })
    ).resolves.toEqual({ op: 12 });
  });

  it("serves local admin health, status, config, channels and logs", async () => {
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, logBufferSize: 100 },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret",
          enabled: false
        }
      }
    });
    const server = new RuntimeServer({ config, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    expect(started.admin).toBeDefined();
    const adminBaseUrl = `http://127.0.0.1:${started.admin?.port}`;

    await expect(fetchJson(`${adminBaseUrl}/admin/health`)).resolves.toEqual({ ok: true });
    await expect(fetchJson(`${adminBaseUrl}/admin/status`)).resolves.toMatchObject({
      ok: true,
      protocolVersion: 1,
      runtime: {
        mode: "local",
        logLevel: "info"
      },
      channels: [
        {
          id: "qq-official",
          adapter: "qq-official",
          enabled: false,
          status: { state: "disabled" }
        }
      ]
    });
    await expect(fetchJson(`${adminBaseUrl}/admin/channels`)).resolves.toMatchObject({
      ok: true,
      channels: [
        {
          id: "qq-official",
          adapter: "qq-official",
          enabled: false,
          status: { state: "disabled" }
        }
      ]
    });
    await expect(fetchJson(`${adminBaseUrl}/admin/config`)).resolves.toMatchObject({
      ok: true,
      config: {
        channels: {
          "qq-official": {
            appSecret: "[REDACTED]"
          }
        }
      }
    });

    const logs = await fetchJson(`${adminBaseUrl}/admin/logs?limit=2`);
    expect(logs).toMatchObject({ ok: true });
    expect((logs as { logs?: unknown[] }).logs?.length).toBeLessThanOrEqual(2);

    const streamResponse = await fetch(`${adminBaseUrl}/admin/events/stream`);
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();
    const text = reader === undefined ? "" : await readStreamUntil(reader, "event: log");
    expect(text).toContain(": connected");
    expect(text).toContain("event: log");
    await reader?.cancel();
  });

  it("enables and disables channels through the admin API", async () => {
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0 },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret",
          enabled: false
        }
      }
    });
    const server = new RuntimeServer({ config, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const adminBaseUrl = `http://127.0.0.1:${started.admin?.port}`;

    await expect(
      fetchJson(`${adminBaseUrl}/admin/channels/qq-official`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true })
      })
    ).resolves.toMatchObject({
      ok: true,
      channel: {
        id: "qq-official",
        enabled: true,
        status: { state: "online" }
      }
    });
    await expect(
      fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: JSON.stringify({
          op: 13,
          d: {
            plain_token: "plain-token",
            event_ts: "1700000000"
          }
        })
      })
    ).resolves.toMatchObject({ plain_token: "plain-token" });

    await expect(
      fetchJson(`${adminBaseUrl}/admin/channels/qq-official`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false })
      })
    ).resolves.toMatchObject({
      ok: true,
      channel: {
        id: "qq-official",
        enabled: false,
        status: { state: "disabled" }
      }
    });
    await expect(
      fetchStatus(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: JSON.stringify({
          op: 13,
          d: {
            plain_token: "plain-token",
            event_ts: "1700000000"
          }
        })
      })
    ).resolves.toBe(404);
  });

  it("reloads config from disk and rebuilds configured channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-reload-"));
    tempDirs.push(dir);
    const configPath = join(dir, "runtime.config.toml");
    const dataDir = join(dir, "data");
    writeFileSync(configPath, runtimeConfigToml({ enabled: false, dataDir }), "utf8");
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0 },
      channels: {
        "qq-official": {
          adapter: "qq-official",
          appId: "app-id",
          appSecret: "app-secret",
          enabled: false
        }
      }
    });
    const server = new RuntimeServer({ config, configPath, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const adminBaseUrl = `http://127.0.0.1:${started.admin?.port}`;

    await expect(
      fetchStatus(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: JSON.stringify({
          op: 13,
          d: {
            plain_token: "plain-token",
            event_ts: "1700000000"
          }
        })
      })
    ).resolves.toBe(404);

    writeFileSync(configPath, runtimeConfigToml({ enabled: true, dataDir }), "utf8");

    await expect(fetchJson(`${adminBaseUrl}/admin/reload`, { method: "POST" })).resolves.toMatchObject({
      ok: true,
      channels: [
        {
          id: "qq-official",
          enabled: true,
          status: { state: "online" }
        }
      ]
    });
    await expect(
      fetchJson(`${baseUrl}/webhooks/qq-official/qq-official`, {
        method: "POST",
        body: JSON.stringify({
          op: 13,
          d: {
            plain_token: "plain-token",
            event_ts: "1700000000"
          }
        })
      })
    ).resolves.toMatchObject({ plain_token: "plain-token" });
  });

  it("rejects remote admin API without an admin token", async () => {
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "0.0.0.0", port: 0 }
    });
    const server = new RuntimeServer({ config, logger: silentLogger });
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/Remote admin API requires admin\.token/);
  });

  it("requires admin bearer token when token is configured", async () => {
    const config = parseTestConfig({
      server: { host: "127.0.0.1", port: 0 },
      admin: { host: "127.0.0.1", port: 0, token: "admin-token" }
    });
    const server = new RuntimeServer({ config, logger: silentLogger });
    servers.push(server);
    const started = await server.start();
    const adminBaseUrl = `http://127.0.0.1:${started.admin?.port}`;

    await expect(fetchStatus(`${adminBaseUrl}/admin/status`)).resolves.toBe(401);
    await expect(
      fetchJson(`${adminBaseUrl}/admin/status`, {
        headers: {
          authorization: "Bearer admin-token"
        }
      })
    ).resolves.toMatchObject({ ok: true });
  });

  it("loads .env files without overwriting existing variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-"));
    const envFile = join(dir, ".env");
    const env: NodeJS.ProcessEnv = { EXISTING: "kept" };
    writeFileSync(envFile, "QWEN_API_KEY = qwen-key\nEXISTING = replaced\nQUOTED='value'\n", "utf8");

    loadEnvFile(envFile, env);

    expect(env.QWEN_API_KEY).toBe("qwen-key");
    expect(env.EXISTING).toBe("kept");
    expect(env.QUOTED).toBe("value");
  });
});

type FetchJsonInit = Omit<RequestInit, "body"> & {
  readonly body?: BodyInit | SignedQqBody;
};

async function fetchJson(url: string, init?: FetchJsonInit): Promise<unknown> {
  const { body: rawBody, ...restInit } = init ?? {};
  const headers = rawBody instanceof SignedQqBody ? rawBody.headers : {};
  const body = rawBody instanceof SignedQqBody ? rawBody.content : rawBody;
  const response = await fetch(url, {
    ...restInit,
    ...(body === undefined ? {} : { body }),
    headers: {
      "content-type": "application/json",
      ...headers,
      ...restInit.headers
    }
  });

  return response.json() as Promise<unknown>;
}

async function fetchStatus(url: string, init?: FetchJsonInit): Promise<number> {
  const { body: rawBody, ...restInit } = init ?? {};
  const headers = rawBody instanceof SignedQqBody ? rawBody.headers : {};
  const body = rawBody instanceof SignedQqBody ? rawBody.content : rawBody;
  const response = await fetch(url, {
    ...restInit,
    ...(body === undefined ? {} : { body }),
    headers: {
      "content-type": "application/json",
      ...headers,
      ...restInit.headers
    }
  });

  return response.status;
}

async function readStreamUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string): Promise<string> {
  return readStreamUntilWithin(reader, pattern, 5, "");
}

async function readStreamUntilWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
  remainingReads: number,
  text: string
): Promise<string> {
  if (remainingReads <= 0 || text.includes(pattern)) {
    return text;
  }

  const decoder = new TextDecoder();
  const chunk = await reader.read();

  if (chunk.done) {
    return text;
  }

  return readStreamUntilWithin(
    reader,
    pattern,
    remainingReads - 1,
    text + decoder.decode(chunk.value, { stream: true })
  );
}

class SignedQqBody {
  readonly content: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(appSecret: string, value: unknown) {
    this.content = JSON.stringify(value);
    const timestamp = "1725442341";
    this.headers = {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signQqBody(appSecret, timestamp, this.content)
    };
  }
}

function signedQqBody(appSecret: string, value: unknown): SignedQqBody {
  return new SignedQqBody(appSecret, value);
}

function parseTestConfig(config: Readonly<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "synapse-runtime-data-"));
  tempDirs.push(dir);
  const runtime = isRecord(config.runtime) ? config.runtime : {};

  return parseConfigObject({
    ...config,
    runtime: {
      dataDir: dir,
      ...runtime
    }
  });
}

function signQqBody(appSecret: string, timestamp: string, body: string): string {
  const seed = createQqOfficialSeed(appSecret);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });

  return sign(null, Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body, "utf8")]), privateKey).toString(
    "hex"
  );
}

function createQqOfficialSeed(appSecret: string): Buffer {
  let seed = appSecret;

  while (Buffer.byteLength(seed, "utf8") < 32) {
    seed += seed;
  }

  return Buffer.from(seed, "utf8").subarray(0, 32);
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeConfigToml(options: { readonly enabled: boolean; readonly dataDir: string }): string {
  const dataDir = options.dataDir.replace(/\\/g, "/");

  return `
[runtime]
mode = "local"
dataDir = "${dataDir}"

[server]
host = "127.0.0.1"
port = 0

[admin]
host = "127.0.0.1"
port = 0

[channels."qq-official"]
adapter = "qq-official"
appId = "app-id"
appSecret = "app-secret"
enabled = ${String(options.enabled)}
`;
}

const silentLogger = {
  info() {},
  warn() {},
  error() {}
};
