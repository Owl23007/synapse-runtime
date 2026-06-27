import type { AddressInfo, Server as NetServer } from "node:net";
import type { Nova, NovaRequest, NovaResponse } from "nova-http";

export function readJsonBody(request: NovaRequest): unknown {
  if (request.bodySize === 0) {
    return {};
  }

  if (request.bodyParsed !== undefined) {
    return request.bodyParsed;
  }

  return JSON.parse(request.body.toString("utf8")) as unknown;
}

export function sendJson(response: NovaResponse, statusCode: number, body: unknown): void {
  response.status(statusCode).setHeader("content-type", "application/json; charset=utf-8").json(body);
}

export function getNovaServerAddress(app: Nova): AddressInfo | string | null {
  const server = (app as unknown as { readonly _server: NetServer | null })._server;
  return server?.address() ?? null;
}
