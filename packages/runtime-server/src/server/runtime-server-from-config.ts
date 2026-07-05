import { loadConfigFile } from "@synapse/runtime-config";
import type { RuntimeServerOptions } from "../types.js";
import { RuntimeServer } from "./runtime-server.js";

export async function startRuntimeServerFromConfigFile(
  configPath: string,
  options: Omit<RuntimeServerOptions, "config"> = {}
): Promise<RuntimeServer> {
  const config = await loadConfigFile(configPath);
  const server = new RuntimeServer({ ...options, config, configPath });
  await server.start();
  return server;
}
