import { describe, expect, it } from "vitest";
import {
  createQqOfficialWebhookValidationResponse,
  normalizeQqOfficialDispatch,
  QqOfficialAccessTokenClient,
  QqOfficialChannelAdapter,
  textMessage
} from "./index.js";

describe("QqOfficialAccessTokenClient", () => {
  it("requests and caches app access tokens", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const client = new QqOfficialAccessTokenClient({
      appId: "app-id",
      appSecret: "app-secret",
      tokenEndpoint: "https://token.example.test",
      now: () => 1_000,
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.body === undefined ? {} : { body: init.body })
        });
        return jsonResponse({ access_token: "token-1", expires_in: "7200" });
      }
    });

    await expect(client.getAccessToken()).resolves.toBe("token-1");
    await expect(client.getAccessToken()).resolves.toBe("token-1");

    expect(requests).toEqual([
      {
        url: "https://token.example.test",
        body: JSON.stringify({ appId: "app-id", clientSecret: "app-secret" })
      }
    ]);
  });

  it("accepts camel-case token response fields", async () => {
    const client = new QqOfficialAccessTokenClient({
      appId: "app-id",
      appSecret: "app-secret",
      tokenEndpoint: "https://token.example.test",
      fetch: async () => jsonResponse({ accessToken: "token-1", expiresIn: "7200" })
    });

    await expect(client.getAccessToken()).resolves.toBe("token-1");
  });

  it("includes redacted token response bodies when parsing fails", async () => {
    const client = new QqOfficialAccessTokenClient({
      appId: "app-id",
      appSecret: "app-secret",
      tokenEndpoint: "https://token.example.test",
      fetch: async () => jsonResponse({ code: 401, message: "bad credentials", clientSecret: "secret-value" })
    });

    await expect(client.getAccessToken()).rejects.toThrow(
      'QQ official token response is missing "access_token/accessToken": {"code":401,"message":"bad credentials","clientSecret":"[REDACTED]"}'
    );
  });
});

describe("QQ official webhook validation", () => {
  it("creates the callback validation response required by QQ official", () => {
    expect(
      createQqOfficialWebhookValidationResponse("abcd", {
        plain_token: "plain-token",
        event_ts: "1700000000"
      })
    ).toEqual({
      plain_token: "plain-token",
      signature:
        "f05f8b777c33904554b311e72f6396f3a55d2617dcef8869f166388bb2edc9e0872da4db97adbe0d2ba4e517edd7ac57da9f1a598f7ba01c874901df835f090b"
    });
  });
});

describe("normalizeQqOfficialDispatch", () => {
  it("normalizes official group message events into Synapse channel events", () => {
    const event = normalizeQqOfficialDispatch("qq-official", {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "event-1",
        msg_id: "message-1",
        group_openid: "group-openid",
        content: "hello Synapse",
        timestamp: "2026-06-27T08:00:00+08:00",
        author: {
          user_openid: "user-openid",
          username: "Alice"
        }
      }
    });

    expect(event).toMatchObject({
      id: "event-1",
      platform: "qq",
      channelId: "qq-official",
      eventType: "message.created",
      conversation: { id: "group-openid", kind: "group" },
      sender: { id: "user-openid", displayName: "Alice" },
      message: {
        id: "message-1",
        type: "text",
        segments: [{ type: "text", text: "hello Synapse" }, { type: "mention" }]
      }
    });
  });
});

describe("QqOfficialChannelAdapter", () => {
  it("sends group text messages through QQ official v2 API", async () => {
    const requests: Array<{ url: string; headers?: Readonly<Record<string, string>>; body?: string }> = [];
    const adapter = new QqOfficialChannelAdapter({
      id: "qq-official",
      appId: "app-id",
      appSecret: "app-secret",
      apiBaseUrl: "https://api.example.test",
      tokenEndpoint: "https://token.example.test",
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body })
        });

        if (url === "https://token.example.test") {
          return jsonResponse({ access_token: "token-1", expires_in: 7200 });
        }

        return jsonResponse({ id: "sent-1" });
      }
    });

    const result = await adapter.sendMessage(
      { type: "group", groupId: "group-openid" },
      {
        ...textMessage("hello"),
        replyTo: {
          messageId: "message-1",
          eventId: "event-1",
          sequence: 1
        }
      }
    );

    expect(result).toEqual({ ok: true, messageId: "sent-1" });
    expect(requests.at(-1)).toEqual({
      url: "https://api.example.test/v2/groups/group-openid/messages",
      headers: {
        authorization: "QQBot token-1",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: "hello",
        msg_type: 0,
        msg_id: "message-1",
        msg_seq: 1
      })
    });
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}
