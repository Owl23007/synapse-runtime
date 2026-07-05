import { redactConfig, type ChannelConfig, type RuntimeConfig } from "@synapse/runtime-config";
import type { Handler, Nova, NovaRequest, NovaResponse } from "nova-http";
import type { RuntimeLogBuffer } from "../../logging.js";
import type { RuntimeServerLogger } from "../../types.js";
import { readJsonBody, sendJson } from "../http.js";
import { authorizeAdminRequest } from "./auth.js";
import { isChannelAdminPatch, parsePositiveInt, type ChannelAdminPatch } from "./dto.js";
import { streamLogEvents } from "./logs-sse.js";

export interface AdminRouteDeps {
  readonly app: Nova;
  readonly getConfig: () => RuntimeConfig;
  readonly getConfigPath: () => string | undefined;
  readonly getStartedAt: () => string;
  readonly logBuffer: RuntimeLogBuffer;
  readonly logger: RuntimeServerLogger;
  readonly getChannelSummaries: () => Promise<unknown[]>;
  readonly getChannelSummary: (channelId: string, channelConfig: ChannelConfig) => Promise<unknown>;
  readonly applyChannelPatch: (
    channelId: string,
    channelConfig: ChannelConfig,
    patch: ChannelAdminPatch
  ) => Promise<void>;
  readonly reloadConfig: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export function registerAdminRoutes(deps: AdminRouteDeps): void {
  deps.app.use("/admin", (request: NovaRequest, response: NovaResponse, next: () => void) => {
    if (!authorizeAdminRequest(deps.getConfig().admin, request, response)) {
      return;
    }

    next();
  });
  deps.app.get("/admin/health", (_request: NovaRequest, response: NovaResponse) => {
    sendJson(response, 200, { ok: true });
  });
  deps.app.get(
    "/admin/status",
    asyncRoute(deps, async (_request: NovaRequest, response: NovaResponse) => {
      const config = deps.getConfig();
      sendJson(response, 200, {
        ok: true,
        protocolVersion: 1,
        runtime: {
          mode: config.runtime.mode,
          logLevel: config.runtime.logLevel,
          startedAt: deps.getStartedAt()
        },
        server: {
          host: config.server.host,
          port: config.server.port
        },
        admin: {
          host: config.admin.host,
          port: config.admin.port
        },
        channels: await deps.getChannelSummaries()
      });
    })
  );
  deps.app.get("/admin/config", (_request: NovaRequest, response: NovaResponse) => {
    sendJson(response, 200, {
      ok: true,
      config: redactConfig(deps.getConfig())
    });
  });
  deps.app.get(
    "/admin/channels",
    asyncRoute(deps, async (_request: NovaRequest, response: NovaResponse) => {
      sendJson(response, 200, {
        ok: true,
        channels: await deps.getChannelSummaries()
      });
    })
  );
  deps.app.patch(
    "/admin/channels/:id",
    asyncRoute(deps, async (request: NovaRequest, response: NovaResponse) => {
      const channelId = request.params.id;

      if (channelId === undefined) {
        sendJson(response, 400, { ok: false, error: "missing_channel_id" });
        return;
      }

      const config = deps.getConfig();
      const channelConfig = config.channels[channelId];

      if (channelConfig === undefined) {
        sendJson(response, 404, { ok: false, error: "channel_not_found" });
        return;
      }

      const patch = readJsonBody(request);
      if (!isChannelAdminPatch(patch)) {
        sendJson(response, 400, { ok: false, error: "invalid_channel_patch" });
        return;
      }

      try {
        await deps.applyChannelPatch(channelId, channelConfig, patch);
        const nextChannelConfig = deps.getConfig().channels[channelId] ?? channelConfig;
        sendJson(response, 200, {
          ok: true,
          channel: await deps.getChannelSummary(channelId, nextChannelConfig)
        });
      } catch (error) {
        deps.logger.error("Admin channel patch failed.", {
          channelId,
          error: error instanceof Error ? error.message : String(error)
        });
        sendJson(response, 500, { ok: false, error: "channel_patch_failed" });
      }
    })
  );
  deps.app.get("/admin/logs", (request: NovaRequest, response: NovaResponse) => {
    const limit = parsePositiveInt(request.query.get("limit")) ?? 100;
    sendJson(response, 200, {
      ok: true,
      logs: deps.logBuffer.entries.slice(-limit)
    });
  });
  deps.app.get("/admin/events/stream", (_request: NovaRequest, response: NovaResponse) =>
    streamLogEvents(response, deps.logBuffer)
  );
  deps.app.post(
    "/admin/reload",
    asyncRoute(deps, async (_request: NovaRequest, response: NovaResponse) => {
      if (deps.getConfigPath() === undefined) {
        sendJson(response, 400, { ok: false, error: "reload_config_path_not_available" });
        return;
      }

      try {
        await deps.reloadConfig();
        sendJson(response, 200, {
          ok: true,
          config: redactConfig(deps.getConfig()),
          channels: await deps.getChannelSummaries()
        });
      } catch (error) {
        deps.logger.error("Admin reload failed.", {
          error: error instanceof Error ? error.message : String(error)
        });
        sendJson(response, 500, { ok: false, error: "reload_failed" });
      }
    })
  );
  deps.app.post("/admin/shutdown", (_request: NovaRequest, response: NovaResponse) => {
    sendJson(response, 202, { ok: true });

    setTimeout(() => {
      deps.shutdown().catch((error) => {
        deps.logger.error("Admin shutdown failed.", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 0);
  });
}

function asyncRoute(deps: Pick<AdminRouteDeps, "logger">, handler: Handler): Handler {
  return (request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      deps.logger.error("HTTP route handler failed.", {
        error: error instanceof Error ? error.message : String(error)
      });

      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: "internal_error" });
      }
    });
  };
}
