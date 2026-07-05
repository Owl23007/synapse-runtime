import type { RuntimeConfig } from "@synapse/runtime-config";
import type { Nova } from "nova-http";
import type { RuntimeServerLogger, RuntimeServerStartResult } from "../types.js";
import { getNovaServerAddress } from "./http.js";

export async function startAdminApp(input: {
  readonly app: Nova;
  readonly config: RuntimeConfig;
  readonly logger: RuntimeServerLogger;
}): Promise<RuntimeServerStartResult["admin"] | undefined> {
  if (!input.config.admin.enabled) {
    return undefined;
  }

  await input.app.listen(input.config.admin.port, input.config.admin.host);
  const address = getNovaServerAddress(input.app);
  const result =
    typeof address === "object" && address !== null
      ? { host: input.config.admin.host, port: address.port }
      : { host: input.config.admin.host, port: input.config.admin.port };
  input.logger.info("Synapse Runtime admin API started.", result);
  return result;
}

export function serverStartResult(input: {
  readonly app: Nova;
  readonly config: RuntimeConfig;
  readonly admin?: RuntimeServerStartResult["admin"];
}): RuntimeServerStartResult {
  const address = getNovaServerAddress(input.app);
  return typeof address === "object" && address !== null
    ? {
        host: input.config.server.host,
        port: address.port,
        ...(input.admin === undefined ? {} : { admin: input.admin })
      }
    : {
        host: input.config.server.host,
        port: input.config.server.port,
        ...(input.admin === undefined ? {} : { admin: input.admin })
      };
}
