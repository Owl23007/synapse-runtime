import type { RuntimeConfig, LoadConfigOptions } from "./config/index.js";

/** 应用实例及其配置来源，重载时沿用同一组覆盖规则 */
export interface RuntimeServerOptions {
  readonly loadConfigOptions?: LoadConfigOptions;
  readonly config: RuntimeConfig;
  readonly configPath?: string;
  readonly awaitDispatch?: boolean;
  readonly fetch?: RuntimeFetch;
  readonly logger?: RuntimeServerLogger;
}

export type RuntimeFetch = (url: string, init?: RuntimeFetchInit) => Promise<RuntimeFetchResponse>;

export interface RuntimeFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface RuntimeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface RuntimeServerLogger {
  debug?(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: RuntimeLogLevel;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeServerStartResult {
  readonly host: string;
  readonly port: number;
  readonly admin?: {
    readonly host: string;
    readonly port: number;
  };
}
