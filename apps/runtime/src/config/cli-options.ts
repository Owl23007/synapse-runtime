import type { LoadConfigOptions } from "./loader.js";

/** CLI 覆盖所需选项，可同时用于进程入口和本地控制台 */
export interface ConfigCliOptions {
  readonly workspaceConfigPath?: string;
  readonly userConfigPath?: string;
  readonly adminHost?: string;
  readonly adminPort?: number;
  readonly adminTokenEnv?: string;
}

/** 将命令行值转为配置来源，由统一解析链验证并应用优先级 */
export function configLoadOptions(options: ConfigCliOptions): LoadConfigOptions {
  const token = options.adminTokenEnv === undefined ? undefined : process.env[options.adminTokenEnv];
  if (options.adminTokenEnv !== undefined && token === undefined)
    throw new Error(`Environment variable "${options.adminTokenEnv}" is not set`);
  return {
    ...(options.workspaceConfigPath === undefined ? {} : { workspaceConfigPath: options.workspaceConfigPath }),
    ...(options.userConfigPath === undefined ? {} : { userConfigPath: options.userConfigPath }),
    cliOverrides: {
      admin: {
        ...(options.adminHost === undefined ? {} : { host: options.adminHost }),
        ...(options.adminPort === undefined ? {} : { port: options.adminPort }),
        ...(token === undefined ? {} : { token })
      }
    }
  };
}
