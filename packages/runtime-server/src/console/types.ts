import type { RuntimeConfig } from "@synapse/runtime-config";
import type { RuntimeServerStartResult } from "../types.js";

export type ConsoleLevel = "debug" | "info" | "warn" | "error";
export type ConsoleStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type ConsoleView = "overview" | "logs" | "config" | "channels" | "help";

export interface RuntimeConsoleOptions {
  readonly configPath: string;
  readonly envFile?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly profile?: string;
  readonly profilePath?: string;
  readonly spawn?: boolean;
}

export interface RuntimeConsoleChannelSummary {
  readonly id: string;
  readonly adapter: string;
  readonly enabled: boolean;
  readonly provider?: string;
  readonly status?: {
    readonly state?: string;
    readonly detail?: string;
    readonly checkedAt?: string;
  };
}

export interface ConsoleLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: ConsoleLevel;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConsoleState {
  readonly status: ConsoleStatus;
  readonly view: ConsoleView;
  readonly configPath: string;
  readonly endpoint?: string;
  readonly config?: RuntimeConfig;
  readonly started?: RuntimeServerStartResult;
  readonly channels?: readonly RuntimeConsoleChannelSummary[];
  readonly logs: readonly ConsoleLogEntry[];
  readonly notices: readonly string[];
}

export type StateListener = (state: ConsoleState) => void;
