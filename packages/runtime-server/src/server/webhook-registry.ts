import type { ChannelAdapter } from "@synapse/runtime-channel";
import { QqOfficialChannelAdapter } from "@synapse/runtime-channel-qq-official";
import type { ChannelConfig } from "@synapse/runtime-config";
import type { Handler, Nova, NovaRequest, NovaResponse } from "nova-http";
import type { RuntimeServerLogger } from "../types.js";
import { sendJson } from "./http.js";
import { handleQqOfficialWebhook, type QqOfficialRoute } from "./qq-official-webhook.js";

export interface QqOfficialWebhookRegistryOptions {
  readonly app: Nova;
  readonly awaitDispatch: boolean;
  readonly logger: RuntimeServerLogger;
}

export class QqOfficialWebhookRegistry {
  readonly #app: Nova;
  readonly #awaitDispatch: boolean;
  readonly #logger: RuntimeServerLogger;
  readonly #routes = new Map<string, QqOfficialRoute>();
  readonly #registeredPaths = new Set<string>();

  constructor(options: QqOfficialWebhookRegistryOptions) {
    this.#app = options.app;
    this.#awaitDispatch = options.awaitDispatch;
    this.#logger = options.logger;
  }

  register(channelId: string, channelConfig: ChannelConfig, channel: ChannelAdapter): void {
    if (channelConfig.adapter !== "qq-official" || !(channel instanceof QqOfficialChannelAdapter)) {
      return;
    }

    const path = channelConfig.webhookPath ?? `/webhooks/qq-official/${channelId}`;
    const route: QqOfficialRoute = {
      path,
      appSecret: channelConfig.appSecret,
      adapter: channel
    };
    this.#routes.set(path, route);
    if (this.#registeredPaths.has(path)) {
      return;
    }

    this.#registeredPaths.add(path);
    this.#app.post(
      path,
      this.#asyncRoute(async (request: NovaRequest, response: NovaResponse) => {
        const activeRoute = this.#routes.get(path);

        if (activeRoute === undefined) {
          sendJson(response, 404, { ok: false, error: "channel_route_disabled" });
          return;
        }

        try {
          await handleQqOfficialWebhook({
            route: activeRoute,
            request,
            response,
            awaitDispatch: this.#awaitDispatch,
            logger: this.#logger
          });
        } catch (error) {
          this.#logger.error("Unhandled QQ official webhook error.", {
            channelId,
            path,
            error: error instanceof Error ? error.message : String(error)
          });
          sendJson(response, 500, { ok: false, error: "internal_error" });
        }
      })
    );
    this.#logger.info("Registered QQ official webhook route.", { channelId, path });
  }

  remove(channelId: string, channelConfig: ChannelConfig): void {
    if (channelConfig.adapter !== "qq-official") {
      return;
    }

    const path = channelConfig.webhookPath ?? `/webhooks/qq-official/${channelId}`;
    this.#routes.delete(path);
  }

  clear(): void {
    this.#routes.clear();
  }

  #asyncRoute(handler: Handler): Handler {
    return (request, response) => {
      void Promise.resolve(handler(request, response)).catch((error) => {
        this.#logger.error("HTTP route handler failed.", {
          error: error instanceof Error ? error.message : String(error)
        });

        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: "internal_error" });
        }
      });
    };
  }
}
