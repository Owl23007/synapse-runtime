import type { RuntimeConfig } from "@synapse/runtime-config";

export interface RuntimeServerOptions {
  readonly config: RuntimeConfig;
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

export interface RuntimeServerStartResult {
  readonly host: string;
  readonly port: number;
}
