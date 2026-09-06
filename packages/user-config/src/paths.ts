import { homedir } from "node:os";
import { join } from "node:path";

/** 返回用户态 Runtime 配置的默认路径 */
export function getDefaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNAPSE_USER_CONFIG ?? join(homedir(), ".synapse", "config.toml");
}
