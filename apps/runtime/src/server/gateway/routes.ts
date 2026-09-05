import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import { sendJson } from "../http.js";

export function registerGatewayRoutes(app: Nova): void {
  app.get("/health", (_request: NovaRequest, response: NovaResponse) => {
    sendJson(response, 200, { ok: true });
  });
}
