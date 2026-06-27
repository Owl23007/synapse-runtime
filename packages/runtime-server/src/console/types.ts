import type { RuntimeConfig } from "@synapse/runtime-config";
import type { RuntimeServerStartResult } from "../types.js";

export type ConsoleLevel = "debug" | "info" | "warn" | "error";
export type ConsoleStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type ConsoleView = "overview" | "logs" | "config" | "channels" | "help";

export interface RuntimeConsoleOptions {
  readonly configPath: string;
  readonly envFile?: string;
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
  readonly config?: RuntimeConfig;
  readonly started?: RuntimeServerStartResult;
  readonly logs: readonly ConsoleLogEntry[];
  readonly notices: readonly string[];
}

export type StateListener = (state: ConsoleState) => void;
