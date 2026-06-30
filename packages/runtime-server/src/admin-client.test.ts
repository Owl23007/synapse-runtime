import { describe, expect, it } from "vitest";
import { RuntimeAdminClient, type AdminFetchInit } from "./admin-client.js";

describe("RuntimeAdminClient", () => {
  it("sends admin mutation requests with bearer token", async () => {
    const requests: Array<{ url: string; init?: AdminFetchInit }> = [];
    const client = new RuntimeAdminClient({
      endpoint: "http://127.0.0.1:3766/",
      token: "admin-token",
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init === undefined ? {} : { init })
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          }
        };
      }
    });

    await expect(client.updateChannel("qq-official", { enabled: false })).resolves.toEqual({ ok: true });
    await expect(client.reload()).resolves.toEqual({ ok: true });
    await expect(client.shutdown()).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3766/admin/channels/qq-official",
        init: {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: "Bearer admin-token"
          },
          body: JSON.stringify({ enabled: false })
        }
      },
      {
        url: "http://127.0.0.1:3766/admin/reload",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer admin-token"
          }
        }
      },
      {
        url: "http://127.0.0.1:3766/admin/shutdown",
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: "Bearer admin-token"
          }
        }
      }
    ]);
  });
});
